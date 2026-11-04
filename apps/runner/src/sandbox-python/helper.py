# The sandbox's helper (see apps/runner/src/sandbox.ts): every untrusted filesystem access of the Linux sandbox and the
# macOS (Seatbelt) backend happens here, after entering the namespace. realpath is only a policy check: actual opens
# walk pinned directory descriptors with O_NOFOLLOW, so swapping a checked parent for a symlink cannot win a race.
#
# It runs as `python3 -I -c <this file>`, embedded in the connector through sandbox-python.generated.ts
# (`pnpm python:embed` writes it; tests/sandbox-python.test.ts checks it is current).
import base64
import errno
import json
import os
import re
import resource
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time

# Where the host's repository mirrors are mounted: sandbox.ts MIRROR_ROOT (tests/sandbox-python.test.ts checks it).
MIRROR_ROOT = '/repository-mirrors'

# Linux lists a process's descriptors in /proc; macOS (the Seatbelt backend) in /dev/fd.
for fd_name in os.listdir('/proc/self/fd' if os.path.isdir('/proc/self/fd') else '/dev/fd'):
    fd = int(fd_name)
    if fd > 2:
        try:
            os.close(fd)
        except OSError:
            pass
os.umask(0o077)
PUSH_KINDS = ('clone-push-prepare', 'clone-push-pack')
# Checkouts from the host repository cache write whole repositories, like pushes read them.
LONG_KINDS = PUSH_KINDS + ('clone-backup', 'clone-restore')


def bounded(which, value):
    # An unprivileged process can't raise a hard limit: never ask for more than the runner itself has.
    hard = resource.getrlimit(which)[1]
    value = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(which, (value, value))


def limits(request):
    # These remain defense in depth for fixed helpers/test fixtures, NOT session quotas.
    # Push rewrites and packs and cache checkouts handle whole repositories, so only they get larger bounds. A shell
    # command gets the ones the runner chose for the host's command time limit (commandLimits in host-config.ts).
    kind = request['kind']
    push = kind in LONG_KINDS
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    cpu, size, files = (3600, 16 * 1024 * 1024 * 1024, 256) if push else (25, 64 * 1024 * 1024, 256)
    given = request.get('limits') if kind == 'bash' else None
    if given is not None:
        values = [given.get(key) for key in ('cpu', 'size', 'files')] if isinstance(given, dict) and len(given) == 3 else []
        if len(values) != 3 or not all(type(value) is int and 0 < value <= 2 ** 62 for value in values):
            raise ValueError('invalid command limits')
        cpu, size, files = values
    bounded(resource.RLIMIT_CPU, cpu)
    bounded(resource.RLIMIT_FSIZE, size)
    bounded(resource.RLIMIT_NOFILE, files)
    # Shell commands inherit these limits, so they get no address-space cap: Go and Node reserve far
    # more address space than they use, and gh and node abort at start-up under 512 MiB. Their memory
    # bound is the session cgroup's memory.max, which the resource supervisor applies and reads back
    # before bash starts; Sandbox.execute refuses bash without it unless the host's owner waived limits.
    if kind != 'bash':
        memory = (4096 if push else 512) * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        except (ValueError, OSError):
            # macOS doesn't let a process lower its address-space limit; Linux always does.
            if sys.platform != 'darwin':
                raise


HOME = os.environ['HOME']
WORK = os.environ['SANDBOX_WORKTREE']
MAX_FILE = 1024 * 1024
MAX_IMAGE = 16 * 1024 * 1024
# Mirrors MAX_IMAGE_BYTES and IMAGE_SIGNATURES in images.ts, which re-checks the signature of every image returned.
IMAGE_SIGNATURES = (
    ((0, b'\x89PNG\r\n\x1a\n'),),
    ((0, b'\xff\xd8\xff'),),
    ((0, b'GIF87a'),),
    ((0, b'GIF89a'),),
    ((0, b'RIFF'), (8, b'WEBP')),
)
MAX_SNAPSHOT = 32 * 1024 * 1024
# Mirrors fileUploadLimits.maxBytes in packages/shared/src/file-uploads.ts.
MAX_IMPORT = 50 * 1024 * 1024
MAX_ENTRIES = 10000
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

def parts_for(value, writing=False):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError('invalid relative path')
    if value.startswith('/') or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('invalid relative path')
    if len(value) >= 2 and value[1] == ':':
        raise ValueError('absolute paths are not allowed')
    if value != '.' and any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('path traversal is not allowed')
    lexical = [] if value == '.' else value.split('/')
    if writing and any(p.lower() == '.git' for p in lexical):
        raise ValueError('Git metadata is protected')
    canonical = os.path.realpath(os.path.join(WORK, value))
    if os.path.commonpath((WORK, canonical)) != WORK:
        raise ValueError('path escapes the worktree')
    relative = os.path.relpath(canonical, WORK)
    parts = [] if relative == '.' else relative.split('/')
    if writing and any(p.lower() == '.git' for p in parts):
        raise ValueError('Git metadata is protected')
    return parts


def walk(root, parts, create=False):
    current = os.dup(root)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('only regular, non-hardlinked files are supported')


def read_at(parent, name, limit):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(fd)
        regular(before)
        if before.st_size > limit:
            raise ValueError('file exceeds size limit')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError('file exceeds size limit')
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('file changed while being read; retry the operation')
        return b''.join(chunks), stat.S_IMODE(before.st_mode) & 0o777
    finally:
        os.close(fd)


# Mirror fileBrowserLimits in packages/shared/src/types.ts.
BROWSE_ENTRIES = 1000
BROWSE_TEXT = 256 * 1024
BROWSE_IMAGE = 2 * 1024 * 1024
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/gif', 'image/webp')


def entry_type(mode):
    if stat.S_ISDIR(mode):
        return 'directory'
    if stat.S_ISREG(mode):
        return 'file'
    if stat.S_ISLNK(mode):
        return 'symlink'
    return 'other'


def browse_directory(directory):
    # Entries are lstat-ed, never followed: a symlink is listed as one, and opening it resolves it again under parts_for.
    names = os.listdir(directory)
    if len(names) > MAX_ENTRIES * 10:
        raise ValueError('directory has too many entries')
    entries = []
    for name in names:
        try:
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        kind = entry_type(info.st_mode)
        entry = {'name': name, 'type': kind}
        if kind == 'file':
            entry['size'] = info.st_size
        entries.append(entry)
    entries.sort(key=lambda entry: (entry['type'] != 'directory', entry['name']))
    return {'type': 'directory', 'entries': entries[:BROWSE_ENTRIES], 'total': len(entries), 'truncated': len(entries) > BROWSE_ENTRIES}


def read_prefix(fd, limit):
    chunks, size = [], 0
    while size < limit:
        chunk = os.read(fd, min(65536, limit - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b''.join(chunks)


def browse_file(parent, name):
    # O_NONBLOCK keeps a FIFO from blocking the open; only regular files are read.
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return {'type': 'file', 'size': 0, 'truncated': False, 'binary': True}
        size = info.st_size
        head = read_prefix(fd, 16)
        image = next((IMAGE_TYPES[index] for index, signature in enumerate(IMAGE_SIGNATURES)
                      if all(head[offset:offset + len(part)] == part for offset, part in signature)), None)
        if image is not None:
            if size > BROWSE_IMAGE:
                return {'type': 'file', 'size': size, 'truncated': True, 'binary': True}
            data = head + read_prefix(fd, BROWSE_IMAGE + 1 - len(head))
            if len(data) > BROWSE_IMAGE:
                return {'type': 'file', 'size': size, 'truncated': True, 'binary': True}
            return {'type': 'file', 'size': size, 'truncated': False, 'image': {'mimeType': image, 'data': base64.b64encode(data).decode('ascii')}}
        data = head + read_prefix(fd, BROWSE_TEXT + 1 - len(head))
        truncated = len(data) > BROWSE_TEXT or size > BROWSE_TEXT
        data = data[:BROWSE_TEXT]
        if b'\0' in data:
            return {'type': 'file', 'size': size, 'truncated': truncated, 'binary': True}
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError as error:
            # A preview cut inside a multi-byte character ends before it.
            if not truncated or error.start < len(data) - 3 or error.reason != 'unexpected end of data':
                return {'type': 'file', 'size': size, 'truncated': truncated, 'binary': True}
            content = data[:error.start].decode('utf-8')
        return {'type': 'file', 'size': size, 'truncated': truncated, 'text': content}
    finally:
        os.close(fd)


def import_candidate(name, index):
    # Mirrors attachmentCandidate in packages/shared/src/file-uploads.ts.
    if index <= 1:
        return name
    dot = name.rfind('.')
    return '%s (%d)%s' % (name[:dot], index, name[dot:]) if dot > 0 else '%s (%d)' % (name, index)


def import_at(root, request):
    # A file attached to a message: created under a name not taken yet in its directory, never replacing a file.
    name, content = request.get('name'), request.get('data')
    if (not isinstance(name, str) or not name or '/' in name or '\\' in name or name in ('.', '..')
            or name.lower() == '.git' or any(ord(c) < 32 or ord(c) == 127 for c in name) or len(name.encode('utf-8')) > 240):
        raise ValueError('invalid file name')
    if not isinstance(content, str):
        raise ValueError('invalid file data')
    data = base64.b64decode(content, validate=True)
    if len(data) > MAX_IMPORT:
        raise ValueError('file exceeds size limit')
    directory = request.get('directory')
    parts = parts_for(directory, True)
    # The directory itself, never a symlink to another one in the worktree: the file goes only where it was asked to.
    if not parts or parts != directory.split('/'):
        raise ValueError('path component is not a real directory')
    parent = walk(root, parts, True)
    try:
        for index in range(1, 1000):
            candidate = import_candidate(name, index)
            try:
                fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
            except FileExistsError:
                continue
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            except BaseException:
                try:
                    os.unlink(candidate, dir_fd=parent)
                except FileNotFoundError:
                    pass
                raise
            os.fsync(parent)
            return '/'.join(parts + [candidate])
        raise ValueError('too many files with this name')
    finally:
        os.close(parent)


def write_at(root, parts, content):
    if not parts:
        raise ValueError('a file path is required')
    data = content.encode('utf-8')
    if len(data) > MAX_FILE:
        raise ValueError('file exceeds size limit')
    parent = walk(root, parts[:-1], True)
    temporary = '.sandbox-write-' + secrets.token_hex(16)
    created = False
    try:
        try:
            regular(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False))
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # renameat replaces an entry; it never follows a concurrently inserted symlink.
        os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


# The move_file, copy_file and delete_file tools (file-operations.ts): mirrors FILE_OPERATIONS_CORE there, so every
# backend answers the same; change both together. Mirrors fileOperationLimits.
COPY_ENTRIES = 10000
COPY_BYTES = 50 * 1024 * 1024
OPERATION_DEPTH = 64


def entry_parts(value):
    # An entry itself: its directory resolved as any written path is (through links that stay in the worktree), its
    # last component never, so a link is moved, copied or deleted as a link.
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError('invalid relative path')
    if value.startswith('/') or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('invalid relative path')
    if len(value) >= 2 and value[1] == ':':
        raise ValueError('absolute paths are not allowed')
    if value == '.':
        raise ValueError('the worktree itself can\'t be moved, copied or deleted')
    if any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('path traversal is not allowed')
    parent, _, name = value.rpartition('/')
    if name.lower() == '.git':
        raise ValueError('Git metadata is protected')
    return parts_for(parent or '.', True), name


def remove_entry(parent, name, depth):
    if depth > OPERATION_DEPTH:
        raise ValueError('directory nesting limit exceeded')
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        fd = os.open(name, DIR_FLAGS, dir_fd=parent)
        try:
            count = 1 + sum(remove_entry(fd, child, depth + 1) for child in os.listdir(fd))
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent)
        return count
    os.unlink(name, dir_fd=parent)
    return 1


def copy_entry(source, name, target, new_name, info, counts, depth, path):
    if depth > OPERATION_DEPTH:
        raise ValueError('directory nesting limit exceeded')
    counts['entries'] += 1
    if counts['entries'] > COPY_ENTRIES:
        raise ValueError('too many files to copy')
    if stat.S_ISLNK(info.st_mode):
        os.symlink(os.readlink(name, dir_fd=source), new_name, dir_fd=target)
        made = os.stat(new_name, dir_fd=target, follow_symlinks=False)
        counts['made'].append((path, (made.st_dev, made.st_ino)))
    elif stat.S_ISDIR(info.st_mode):
        os.mkdir(new_name, 0o700, dir_fd=target)
        counts['made'].append((path, None))
        source_fd = os.open(name, DIR_FLAGS, dir_fd=source)
        try:
            target_fd = os.open(new_name, DIR_FLAGS, dir_fd=target)
            try:
                for child in sorted(os.listdir(source_fd)):
                    if child.lower() == '.git':
                        raise ValueError('Git metadata is protected: clone the repository again rather than copy it')
                    copy_entry(source_fd, child, target_fd, child, os.stat(child, dir_fd=source_fd, follow_symlinks=False), counts, depth + 1, path + [child])
            finally:
                os.close(target_fd)
        finally:
            os.close(source_fd)
    elif stat.S_ISREG(info.st_mode):
        if info.st_nlink != 1:
            raise ValueError('only regular, non-hardlinked files are supported')
        if counts['bytes'] + info.st_size > COPY_BYTES:
            raise ValueError('too much to copy: at most %d bytes of files' % COPY_BYTES)
        data, mode = read_at(source, name, COPY_BYTES - counts['bytes'])
        counts['bytes'] += len(data)
        fd = os.open(new_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o700 if mode & 0o100 else 0o600, dir_fd=target)
        made = os.fstat(fd)
        counts['made'].append((path, (made.st_dev, made.st_ino)))
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        raise ValueError('only files, directories and links can be copied')


def move_entry(source, name, target, new_name, info):
    # Never over something that appeared since the check: a link is made again where it goes, a file gets a second name
    # there before losing its first, and a directory takes the place of an empty one made for it, which a rename
    # replaces only while it is still empty.
    if stat.S_ISLNK(info.st_mode):
        os.symlink(os.readlink(name, dir_fd=source), new_name, dir_fd=target)
        os.unlink(name, dir_fd=source)
    elif stat.S_ISDIR(info.st_mode):
        os.mkdir(new_name, 0o700, dir_fd=target)
        try:
            os.rename(name, new_name, src_dir_fd=source, dst_dir_fd=target)
        except BaseException:
            try:
                os.rmdir(new_name, dir_fd=target)
            except OSError:
                pass
            raise
    else:
        try:
            os.link(name, new_name, src_dir_fd=source, dst_dir_fd=target, follow_symlinks=False)
        except OSError as error:
            # A file system without hard links has no move that can't replace what appears at the destination meanwhile:
            # refused, rather than a rename that might (review of #185).
            if error.errno in (errno.EPERM, errno.ENOTSUP, errno.EXDEV, errno.EMLINK, errno.ENOSYS):
                raise ValueError('this file system can\'t move a file without risking what appears at its destination: '
                                 'copy it, then delete the original') from None
            raise
        os.unlink(name, dir_fd=source)


def walk_existing(root, parts):
    # A directory the operation needs that isn't there: the same refusal on every backend (review of #185).
    try:
        return walk(root, parts)
    except FileNotFoundError:
        raise ValueError('no such file or directory') from None


def file_operation(root, request):
    kind = request['kind']
    if kind == 'delete':
        recursive = request['recursive']
        if not isinstance(recursive, bool):
            raise ValueError('invalid file operation')
        parts, name = entry_parts(request['path'])
        parent = walk_existing(root, parts)
        try:
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                raise ValueError('no such file or directory') from None
            if not recursive:
                # Only the entry itself, never what is in it, whatever it became since the look above (review of #185).
                try:
                    if stat.S_ISDIR(info.st_mode):
                        os.rmdir(name, dir_fd=parent)
                    else:
                        os.unlink(name, dir_fd=parent)
                except OSError as error:
                    if error.errno in (errno.ENOTEMPTY, errno.EEXIST):
                        raise ValueError('the directory is not empty: delete it with recursive') from None
                    if error.errno in (errno.ENOTDIR, errno.EISDIR, errno.EPERM):
                        raise ValueError('it changed while being deleted; try again') from None
                    raise
                return {'entries': 1, 'bytes': 0}
            return {'entries': remove_entry(parent, name, 0), 'bytes': 0}
        finally:
            os.close(parent)
    if kind not in ('move', 'copy'):
        raise ValueError('unsupported filesystem operation')
    source_parts, source_name = entry_parts(request['from'])
    target_parts, target_name = entry_parts(request['to'])
    fold = (lambda parts: [part.lower() for part in parts]) if sys.platform == 'darwin' else (lambda parts: parts)
    whole, inside = fold(source_parts + [source_name]), fold(target_parts + [target_name])
    if inside[:len(whole)] == whole:
        raise ValueError('the destination is the source or inside it')
    source = walk_existing(root, source_parts)
    try:
        try:
            info = os.stat(source_name, dir_fd=source, follow_symlinks=False)
        except FileNotFoundError:
            raise ValueError('no such file or directory') from None
        target = walk(root, target_parts, True)
        try:
            try:
                os.stat(target_name, dir_fd=target, follow_symlinks=False)
                raise ValueError('the destination exists already')
            except FileNotFoundError:
                pass
            if kind == 'move':
                try:
                    move_entry(source, source_name, target, target_name, info)
                except (FileExistsError, OSError) as error:
                    if isinstance(error, FileExistsError) or error.errno == errno.ENOTEMPTY:
                        raise ValueError('the destination exists already') from None
                    raise
                os.fsync(target)
                return {'entries': 1, 'bytes': 0}
            counts = {'entries': 0, 'bytes': 0, 'made': []}
            try:
                copy_entry(source, source_name, target, target_name, info, counts, 0, [target_name])
            except BaseException as error:
                # What the copy made goes again, last first, a directory only while it is empty: what another writer
                # put there meanwhile, or found at the destination, stays.
                # A file or link goes only while it is still the one the copy made (same device and inode): one another
                # writer put in its place stays (review of #185).
                for path, identity in reversed(counts['made']):
                    try:
                        parent = walk(target, path[:-1])
                        try:
                            if identity is None:
                                os.rmdir(path[-1], dir_fd=parent)
                            else:
                                now = os.stat(path[-1], dir_fd=parent, follow_symlinks=False)
                                if (now.st_dev, now.st_ino) == identity:
                                    os.unlink(path[-1], dir_fd=parent)
                        finally:
                            os.close(parent)
                    except OSError:
                        pass
                if isinstance(error, FileExistsError):
                    raise ValueError('the destination exists already') from None
                raise
            os.fsync(target)
            return {'entries': counts['entries'], 'bytes': counts['bytes']}
        finally:
            os.close(target)
    finally:
        os.close(source)


# Hardening shared by every Git invocation; session commands add the worktree and owner identity below.
# Backends without bind mounts (macOS Seatbelt) see the session's Git directory where it is on the host, with a
# gitdir: file at WORK/.git, and name their own Git and Bash; bubblewrap mounts it at WORK/.git and uses /usr/bin.
GITDIR = os.environ.get('SANDBOX_GITDIR') or None
GIT_BINARY = os.environ.get('SANDBOX_GIT') or '/usr/bin/git'
BASH = os.environ.get('SANDBOX_BASH') or '/usr/bin/bash'


def open_gitdir(work):
    return os.open('.git', DIR_FLAGS, dir_fd=work) if GITDIR is None else os.open(GITDIR, DIR_FLAGS)


GIT_HARDENED = [GIT_BINARY, '--no-pager',
                '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                '-c', 'core.attributesFile=/dev/null', '-c', 'core.sshCommand=/usr/bin/false',
                '-c', 'credential.helper=', '-c', 'commit.gpgSign=false',
                '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never',
                '-c', 'core.pager=cat', '-c', 'core.editor=/usr/bin/false',
                '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
                '-c', 'core.preloadIndex=false', '-c', 'index.threads=1']
GIT = GIT_HARDENED + ['-c', 'core.worktree=' + WORK, '-c', 'safe.directory=' + WORK,
                      '-c', 'user.name=' + os.environ['GIT_AUTHOR_NAME'],
                      '-c', 'user.email=' + os.environ['GIT_AUTHOR_EMAIL']]


def egress_relay(path, port):
    # The sandbox has its own network namespace with only loopback. Each connection to the loopback port is relayed,
    # byte for byte, to the session's egress proxy socket, which decides what may leave.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', port))
    listener.listen(64)

    def pump(source, target):
        try:
            while True:
                data = source.recv(65536)
                if not data:
                    break
                target.sendall(data)
        except OSError:
            pass
        finally:
            try:
                target.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def serve(client):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
        except OSError:
            upstream.close()
            client.close()
            return
        back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        back.start()
        pump(client, upstream)
        back.join()
        client.close()
        upstream.close()

    def accept():
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(client,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()


def run(argv, data=None):
    child = subprocess.run(argv, input=data, stdin=subprocess.DEVNULL if data is None else None,
                           cwd=WORK, close_fds=True)
    if child.returncode:
        sys.exit(child.returncode if child.returncode > 0 else 128 - child.returncode)


# Mirrors PACK_SKIPPED_HOME in sandbox.ts: what a pack of the session's files leaves out of its home, all of it downloaded
# again when needed (package managers' caches) or temporary.
PACK_SKIPPED_HOME = ('.tmp', '.cache', '.npm', '.pnpm-store', '.yarn', '.bun', '.local/share/pnpm', '.cargo/registry',
                     '.cargo/git', 'go/pkg/mod', '.m2/repository', '.gradle/caches', '.nuget/packages')


def snapshot(request):
    files, total = [], 0
    # Clones are backed up as bundles (clone-backup), never as files.
    clones = request.get('clones', [])
    if not isinstance(clones, list) or not all(clone_path(path) for path in clones):
        raise ValueError('invalid snapshot request')
    skip_caches = request.get('skipCaches', False)
    if not isinstance(skip_caches, bool):
        raise ValueError('invalid snapshot request')
    skipped = {'worktree/' + path for path in clones}
    if skip_caches:
        skipped |= {'home/' + path for path in PACK_SKIPPED_HOME}

    def add(parent, name, archive_path):
        nonlocal total
        if len(files) >= MAX_ENTRIES:
            raise ValueError('snapshot has too many files')
        data, mode = read_at(parent, name, MAX_SNAPSHOT - total)
        total += len(data)
        files.append({'path': archive_path, 'data': base64.b64encode(data).decode('ascii'), 'mode': mode})

    def visit(fd, prefix, skip=(), depth=0):
        if depth > 64:
            raise ValueError('snapshot directory nesting limit exceeded')
        names = os.listdir(fd)
        if len(names) > MAX_ENTRIES:
            raise ValueError('directory has too many entries')
        for name in sorted(names):
            if name in skip:
                continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            archive_path = prefix + '/' + name
            if archive_path in skipped:
                continue
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try:
                    visit(child, archive_path, depth=depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                add(fd, name, archive_path)
            else:
                # Never follow symlinks or serialize devices/sockets for later restoration.
                raise ValueError('snapshot refuses symlinks and special files')

    home = os.open(HOME, DIR_FLAGS)
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    try:
        visit(home, 'home', ('.gitconfig',))
        owner = os.environ.get('SANDBOX_OWNER_CONFIG')
        if owner is None:
            add(home, '.gitconfig', 'owner.gitconfig')
        else:
            # Not mounted into the home: read where the runner keeps it.
            parent = os.open(os.path.dirname(owner), DIR_FLAGS)
            try:
                add(parent, os.path.basename(owner), 'owner.gitconfig')
            finally:
                os.close(parent)
        visit(work, 'worktree', ('.git',))
        # Push scratch repositories are transient and never belong in a backup; pending clone restorations go with the
        # clones' bundles.
        visit(git, 'git', ('pikibun-push', CLONE_STATE))
        return files
    finally:
        os.close(git)
        os.close(work)
        os.close(home)


OID = re.compile('[0-9a-f]{40}')


def clone_directory(request):
    # A clone the agent made in the worktree: Git runs in it read-only, with its own config but the hardened flags.
    parts = parts_for(request['path'])
    directory = os.path.join(WORK, *parts)
    if not parts or not os.path.isdir(directory) or not os.path.lexists(os.path.join(directory, '.git')):
        raise ValueError('the clone directory is not a Git clone in the worktree')
    return directory


def clone_spawn(directory, arguments, stdout: 'int | None' = subprocess.PIPE, extra=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', **(extra or {}))
    argv = GIT_HARDENED + ['--literal-pathspecs', '-c', 'safe.directory=' + directory, '-C', directory] + arguments
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=stdout, stderr=subprocess.DEVNULL, cwd=directory, env=env, close_fds=True)


def clone_git(directory, arguments, data=b''):
    child = clone_spawn(directory, arguments)
    output, _ = child.communicate(data)
    return child.returncode, output


def clone_head(request):
    directory = clone_directory(request)
    code, output = clone_git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    commit = output.decode('ascii', 'replace').strip()
    if code or not OID.fullmatch(commit):
        raise ValueError('the clone has no commit to push')
    code, output = clone_git(directory, ['config', '--get', 'remote.origin.url'])
    origin = output.decode('utf-8', 'replace').strip() if not code else None
    return {'commit': commit, 'origin': origin[:2048] if origin else None}


def clone_push_prepare(request):
    directory = clone_directory(request)
    commit, old, tips = request['commit'], request['old'], request['tips']
    if (not isinstance(commit, str) or not OID.fullmatch(commit) or (old is not None and (not isinstance(old, str) or not OID.fullmatch(old)))
            or not isinstance(tips, list) or len(tips) > 1024 or not all(isinstance(tip, str) and OID.fullmatch(tip) for tip in tips)):
        raise ValueError('invalid push request')
    names = [commit] + tips
    _, output = clone_git(directory, ['cat-file', '--batch-check=%(objecttype)'], ''.join(name + '^{commit}\n' for name in names).encode('ascii'))
    kinds = output.decode('ascii', 'replace').splitlines()
    if len(kinds) != len(names) or kinds[0] != 'commit':
        raise ValueError('the commit to push is not in the clone')
    present = [tip for tip, kind in zip(tips, kinds[1:]) if kind == 'commit']
    ancestor = None
    if old is not None:
        ancestor = old in present and clone_git(directory, ['merge-base', '--is-ancestor', old, commit])[0] == 0
    revisions = (commit + '\n' + ''.join('^' + tip + '\n' for tip in present)).encode('ascii')
    _, output = clone_git(directory, ['rev-list', '--count', '--stdin'], revisions)
    total = int(output.strip() or b'0')
    _, output = clone_git(directory, ['log', '--stdin', '--max-count=100', '--format=%H%x00%s'], revisions)
    commits = []
    for line in output.decode('utf-8', 'replace').splitlines():
        source, _, subject = line.partition('\0')
        if OID.fullmatch(source):
            commits.append({'source': source, 'subject': subject[:200]})
    return {'present': present, 'ancestor': ancestor, 'commits': commits, 'total': total}


def clone_push_pack(request):
    directory = clone_directory(request)
    commit, exclude = request['commit'], request['exclude']
    if (not isinstance(commit, str) or not OID.fullmatch(commit) or not isinstance(exclude, list) or len(exclude) > 1024
            or not all(isinstance(oid, str) and OID.fullmatch(oid) for oid in exclude)):
        raise ValueError('invalid push request')
    sys.stdout.flush()
    # The pack streams straight to the runner on the helper's stdout.
    child = clone_spawn(directory, ['-c', 'core.bigFileThreshold=64m', 'pack-objects', '--stdout', '--revs',
                                    '--delta-base-offset', '-q'], stdout=None)
    child.communicate((commit + '\n' + ''.join('^' + oid + '\n' for oid in exclude)).encode('ascii'))
    if child.returncode:
        raise ValueError('push pack failed')


# Clone sessions keep their clones' local work in backups as Git bundles, not as files: what the clone's origin already
# has is cloned again on restore. Pending restorations live in the worktree's .git, which shell commands see read-only.
CLONE_STATE = 'pikibun-clones'
CLONE_PATH = re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){0,63}')
MAX_CLONES = 50
MAX_CLONE_BRANCHES = 200
MAX_CLONE_BUNDLES = 16 * 1024 * 1024
MAX_CLONE_SEARCH = 20000
BACKUP_IDENTITY = {'GIT_AUTHOR_NAME': 'Pikibun', 'GIT_AUTHOR_EMAIL': 'backup@pikibun.invalid',
                   'GIT_COMMITTER_NAME': 'Pikibun', 'GIT_COMMITTER_EMAIL': 'backup@pikibun.invalid'}
RESTORED_MARKER = 'pikibun-restored'


def clone_path(value):
    return (isinstance(value, str) and len(value) <= 512 and CLONE_PATH.fullmatch(value) is not None
            and not any(part.lower() in ('.', '..', '.git') for part in value.split('/')))


def branch_name(value):
    # Mirrors validPushBranch in packages/shared/src/repositories.ts: Git's own rules for a branch name.
    return (isinstance(value, str) and 1 <= len(value) <= 200 and value not in ('HEAD', '@') and not value.startswith(('-', 'refs/'))
            and not re.search(r'[\s\x00-\x1f\x7f\\~^:?*[]', value) and not re.search('[\ud800-\udfff]', value)
            and '..' not in value and '@{' not in value and not value.endswith(('.', '/'))
            and not any(not part or part.startswith('.') or part.endswith('.lock') for part in value.split('/')))


def find_clones():
    # Directories of the worktree, up to four levels down, holding a .git directory: what git clone makes. Clones inside
    # clones count too. Dependency trees are not searched, and the search is bounded: a clone it misses is kept as files.
    found, visited = [], 0

    def visit(fd, parts):
        nonlocal visited
        for name in sorted(os.listdir(fd)):
            if name in ('.git', 'node_modules') or visited >= MAX_CLONE_SEARCH:
                continue
            if not stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                continue
            visited += 1
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                try:
                    marker = os.stat('.git', dir_fd=child, follow_symlinks=False)
                except FileNotFoundError:
                    marker = None
                path = '/'.join(parts + [name])
                if marker is not None and stat.S_ISDIR(marker.st_mode) and clone_path(path):
                    if len(found) >= MAX_CLONES:
                        raise ValueError('the worktree has too many clones to back up')
                    found.append(path)
                if len(parts) < 3:
                    visit(child, parts + [name])
            finally:
                os.close(child)

    work = os.open(WORK, DIR_FLAGS)
    try:
        visit(work, [])
    finally:
        os.close(work)
    return found


def clone_state(git):
    # The restorations still pending from the last restore of this session, without their bundles.
    try:
        state = os.open(CLONE_STATE, DIR_FLAGS, dir_fd=git)
    except FileNotFoundError:
        return None, []
    try:
        data, _ = read_at(state, 'manifest.json', MAX_FILE)
    except FileNotFoundError:
        return state, []
    clones = json.loads(data).get('clones')
    if not isinstance(clones, list):
        raise ValueError('invalid pending clone restorations')
    return state, clones


def save_clone_state(state, clones):
    text = json.dumps({'version': 1, 'clones': clones}, ensure_ascii=True).encode('ascii')
    fd = os.open('manifest.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=state)
    try:
        os.write(fd, text)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename('manifest.json.tmp', 'manifest.json', src_dir_fd=state, dst_dir_fd=state)


def clone_git_checked(directory, arguments, data=b'', extra=None, reason='the clone could not be backed up'):
    child = clone_spawn(directory, arguments, extra=extra)
    output, _ = child.communicate(data)
    if child.returncode:
        raise ValueError(reason)
    return output.decode('utf-8', 'replace').strip()


def clone_pack_check(path, directory, reason):
    # A pack replaces the clone with its backup, so what a backup doesn't carry would be lost for good: refused instead.
    # Its backup carries its branches and working tree; a restore clones its origin again, tags included.
    alternates = os.path.join(directory, '.git', 'objects', 'info', 'alternates')
    if os.path.lexists(alternates):
        with open(alternates, 'rb') as stream:
            borrowed = [line.strip() for line in stream.read(65536).splitlines() if line.strip()]
        if not all(os.path.isdir(line) for line in borrowed):
            raise ValueError('the clone ' + path + ' borrows objects from the host cache that this session can\'t read now')
    for name in clone_git_checked(directory, ['for-each-ref', '--format=%(refname)'], reason=reason).splitlines():
        if name == 'refs/stash':
            raise ValueError('the clone ' + path + ' has stashed changes, which a pack can\'t keep')
        if not name.startswith(('refs/heads/', 'refs/remotes/', 'refs/tags/', 'refs/pikibun/')):
            raise ValueError('the clone ' + path + ' has refs other than branches and tags, which a pack can\'t keep')
    # Tags its origin may not have: tags on commits it doesn't have (or on something other than a commit) certainly not.
    code, output = clone_git(directory, ['rev-list', '--count', '--tags', '--not', '--remotes=origin'])
    if code or output.strip() not in (b'', b'0'):
        raise ValueError('the clone ' + path + ' has tags on commits its origin doesn\'t have, which a pack can\'t keep')


def clone_backup_one(path, nested, budget, pack=False):
    directory = os.path.join(WORK, *path.split('/'))
    reason = 'the clone ' + path + ' could not be backed up'
    if pack:
        clone_pack_check(path, directory, reason)
    code, output = clone_git(directory, ['config', '--get', 'remote.origin.url'])
    origin = output.decode('utf-8', 'replace').strip()[:2048] if not code else None
    code, output = clone_git(directory, ['symbolic-ref', '-q', 'HEAD'])
    ref = output.decode('utf-8', 'replace').strip() if not code else ''
    branch = None
    if ref.startswith('refs/heads/'):
        branch = ref[len('refs/heads/'):]
        if not branch_name(branch):
            raise ValueError('the clone ' + path + ' is on a branch whose name can\'t be backed up')
    code, output = clone_git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    head = output.decode('ascii', 'replace').strip() if not code else None
    if head is None and os.path.exists(os.path.join(directory, '.git', 'objects', 'info', 'alternates')):
        # A clone borrowing from the host's mirror reads nothing without it, and the mirror is mounted only while this
        # session may read its repository.
        raise ValueError('the clone ' + path + ' borrows objects from the host cache that this session can\'t read now')
    if head is not None and not OID.fullmatch(head):
        raise ValueError(reason)
    branches = []
    for line in clone_git_checked(directory, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'], reason=reason).splitlines():
        name, _, oid = line.partition('\0')
        if not name.startswith('refs/heads/') or not branch_name(name[len('refs/heads/'):]) or not OID.fullmatch(oid):
            raise ValueError('the clone ' + path + ' has a branch whose name can\'t be backed up')
        branches.append([name[len('refs/heads/'):], oid])
    if len(branches) > MAX_CLONE_BRANCHES:
        raise ValueError('the clone ' + path + ' has too many branches to back up')
    # The working tree, untracked files included and ignored ones not, as a commit on top of HEAD. A copy of the clone's
    # own index is the starting point, so sparse checkouts stay as they are and unchanged files aren't read again; the
    # clone's index and HEAD are left alone. Clones inside this one are backed up on their own.
    index = os.path.join(directory, '.git', 'pikibun-backup-index')
    extra = dict(BACKUP_IDENTITY, GIT_INDEX_FILE=index)
    try:
        try:
            shutil.copyfile(os.path.join(directory, '.git', 'index'), index, follow_symlinks=False)
        except FileNotFoundError:
            clone_git_checked(directory, ['read-tree', head] if head else ['read-tree', '--empty'], extra=extra, reason=reason)
        # Without the clone's LFS filters: git-lfs's clean filter would store a changed LFS file as a pointer to an object
        # in .git/lfs, which the bundle doesn't carry and sessions can't upload, so the change would be lost. Its content
        # goes into the bundle instead (within the budget below); unchanged files keep their pointers from the index.
        clone_git_checked(directory, ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false',
                                      'add', '-A'], extra=extra, reason=reason)
        if nested:
            clone_git_checked(directory, ['update-index', '--force-remove', '--'] + nested, extra=extra, reason=reason)
        tree = clone_git_checked(directory, ['write-tree'], extra=extra, reason=reason)
    finally:
        try:
            os.unlink(index)
        except FileNotFoundError:
            pass
    if not OID.fullmatch(tree):
        raise ValueError(reason)
    # A clean working tree is HEAD itself.
    if head is not None and clone_git_checked(directory, ['rev-parse', head + '^{tree}'], reason=reason) == tree:
        worktree = head
    else:
        worktree = clone_git_checked(directory, ['commit-tree', tree] + (['-p', head] if head else []),
                                     b'Pikibun backup of the working tree\n', extra=BACKUP_IDENTITY, reason=reason)
    if not OID.fullmatch(worktree):
        raise ValueError(reason)
    # Only what the clone's origin has is left out; a restore fetches by commit whatever its origin no longer lists.
    bundle = None
    new = ['refs/pikibun/backup', '--branches', '--not', '--remotes=origin']
    clone_git_checked(directory, ['update-ref', 'refs/pikibun/backup', worktree], reason=reason)
    target = os.path.join(directory, '.git', 'pikibun-backup.bundle')
    try:
        if int(clone_git_checked(directory, ['rev-list', '--count'] + new, reason=reason) or '0'):
            clone_git_checked(directory, ['bundle', 'create', target] + new, reason=reason)
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                if os.fstat(fd).st_size > budget:
                    raise ValueError('the clones\' local work exceeds the backup size limit')
                with os.fdopen(os.dup(fd), 'rb') as handle:
                    bundle = handle.read(budget + 1)
            finally:
                os.close(fd)
            if len(bundle) > budget:
                raise ValueError('the clones\' local work exceeds the backup size limit')
    finally:
        clone_git(directory, ['update-ref', '-d', 'refs/pikibun/backup'])
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
    return {'path': path, 'origin': origin, 'branch': branch, 'head': head, 'worktree': worktree, 'branches': branches,
            'bundle': base64.b64encode(bundle).decode('ascii') if bundle is not None else None}


def clone_backup(pack=False):
    paths = find_clones()
    budget = MAX_CLONE_BUNDLES
    clones = []
    for path in paths:
        nested = [other[len(path) + 1:] for other in paths if other.startswith(path + '/')]
        clone = clone_backup_one(path, nested, budget, pack)
        if clone['bundle'] is not None:
            budget -= len(clone['bundle']) * 3 // 4
        clones.append(clone)
    # Restorations still pending stay in the backup as they were restored, whatever is at their paths now: a restore
    # never clones over something, so they stay pending there too.
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    state = None
    try:
        state, pending = clone_state(git)
        for entry in pending:
            if not isinstance(entry, dict) or not clone_path(entry.get('path')) or entry['path'] in paths:
                continue
            item = dict(entry)
            name = entry.get('bundle')
            item['bundle'] = None
            if name is not None:
                if not isinstance(name, str) or not re.fullmatch(r'[0-9]{1,2}\.bundle', name):
                    raise ValueError('invalid pending clone restorations')
                data, _ = read_at(state, name, budget)
                budget -= len(data)
                item['bundle'] = base64.b64encode(data).decode('ascii')
            clones.append(item)
            if len(clones) > MAX_CLONES:
                raise ValueError('the worktree has too many clones to back up')
    finally:
        if state is not None:
            os.close(state)
        os.close(git)
        os.close(work)
    # The snapshot leaves out the clones found, not the pending ones: whatever is at their paths is kept as files.
    return {'clones': clones, 'found': paths}


def clone_pending():
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    try:
        state, clones = clone_state(git)
        if state is not None:
            os.close(state)
        return [{'path': entry.get('path'), 'origin': entry.get('origin'), 'bundle': entry.get('bundle')}
                for entry in clones if isinstance(entry, dict)]
    finally:
        os.close(git)
        os.close(work)


def bundle_prerequisites(path):
    # The commits a bundle builds on: the "-<oid>" lines of its header, which ends at the first empty line.
    with open(path, 'rb') as handle:
        header = handle.read(4 * 1024 * 1024).split(b'\n\n', 1)[0]
    found = []
    for line in header.split(b'\n')[1:]:
        if line.startswith(b'-'):
            oid = line[1:41].decode('ascii', 'replace')
            if OID.fullmatch(oid):
                found.append(oid)
    return found


def clone_restore(request):
    # Clones one pending clone again through the egress proxy, then puts its local work back from its bundle: its
    # branches, HEAD, and the working tree as uncommitted changes. Its entry goes once that is done.
    path, url, reference = request['path'], request['url'], request.get('reference')
    if (not clone_path(path) or not isinstance(url, str) or not re.fullmatch(r'https://[\x21-\x7e]{1,2040}', url)
            or (reference is not None and (not isinstance(reference, str) or not reference.startswith(MIRROR_ROOT + '/')))):
        raise ValueError('invalid clone restoration')
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    state = None
    try:
        state, clones = clone_state(git)
        entry = next((item for item in clones if isinstance(item, dict) and item.get('path') == path), None)
        if state is None or entry is None:
            raise ValueError('no restoration is pending for this clone')
        origin, branch, head, worktree, branches, bundle = (entry.get(key) for key in ('origin', 'branch', 'head', 'worktree', 'branches', 'bundle'))
        if (not isinstance(origin, str) or not re.fullmatch(r'[\x21-\x7e]{1,2048}', origin) or (branch is not None and not branch_name(branch))
                or (head is not None and not OID.fullmatch(str(head))) or not OID.fullmatch(str(worktree)) or not isinstance(branches, list)
                or not all(isinstance(item, list) and len(item) == 2 and branch_name(item[0]) and OID.fullmatch(str(item[1])) for item in branches)
                or (bundle is not None and (not isinstance(bundle, str) or not re.fullmatch(r'[0-9]{1,2}\.bundle', bundle)))):
            raise ValueError('invalid clone restoration')
        worktree = str(worktree)
        remaining = [item for item in clones if not (isinstance(item, dict) and item.get('path') == path)]
        parts = path.split('/')
        directory = os.path.join(WORK, *parts)
        marker = os.path.join(directory, '.git', RESTORED_MARKER)
        if os.path.lexists(directory):
            # Restored before, but the list kept it (the runner stopped in between): only the list is left to update.
            try:
                with open(marker, 'rb') as handle:
                    done = handle.read(64).decode('ascii', 'replace').strip() == worktree
            except OSError:
                done = False
            if not done or os.path.islink(directory):
                raise ValueError('something else is already at the clone\'s path')
            save_clone_state(state, remaining)
            os.unlink(marker)
            return
        parent = WORK
        for part in parts[:-1]:
            parent = os.path.join(parent, part)
            try:
                os.mkdir(parent, 0o700)
            except FileExistsError:
                if not stat.S_ISDIR(os.lstat(parent).st_mode):
                    raise ValueError('something else is already at the clone\'s path') from None
        # Built beside its path and moved there whole, so an interrupted restoration leaves nothing in the way of the next.
        staging = os.path.join(parent, '.' + parts[-1] + '.pikibun-restore')
        if os.path.lexists(staging):
            if os.path.islink(staging) or not os.path.isdir(staging):
                raise ValueError('something else is already at the clone\'s path')
            shutil.rmtree(staging)
        env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
        # Through the proxy: https remotes are rewritten to its loopback address (see egressEnvironment).
        argv = GIT_HARDENED + ['-c', 'protocol.http.allow=always', 'clone', '--quiet', '--no-checkout']
        if reference is not None:
            argv += ['--reference-if-able', reference]
        child = subprocess.run(argv + ['--', url, staging], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, cwd=parent, env=env, close_fds=True)
        if child.returncode:
            shutil.rmtree(staging, ignore_errors=True)
            raise ValueError('the clone could not be cloned again from its origin')
        reason = 'the clone\'s local work could not be put back'
        try:
            def present(oid):
                return clone_git(staging, ['cat-file', '-e', oid + '^{commit}'])[0] == 0

            # Commits the origin had at backup time but no longer lists (a branch merged and deleted, say) are fetched
            # by commit, which forges allow for what their pull requests still reach.
            def fetch_missing(oids):
                wanted = list(dict.fromkeys(oid for oid in oids if not present(oid)))
                if len(wanted) > 256:
                    raise ValueError('commits the backup builds on are no longer on the clone\'s origin')
                if wanted:
                    clone_git_checked(staging, ['-c', 'protocol.http.allow=always', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', url]
                                      + wanted, reason='commits the backup builds on are no longer on the clone\'s origin')

            if bundle is not None:
                source = os.path.join(GITDIR or os.path.join(WORK, '.git'), CLONE_STATE, bundle)
                fetch_missing(bundle_prerequisites(source))
                clone_git_checked(staging, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', source,
                                            'refs/*:refs/pikibun/restore/*'], reason=reason)
            fetch_missing([oid for _, oid in branches] + ([head] if head else []) + [worktree])
            # The origin as the clone named it (an SSH remote, say), not the form it was cloned again from.
            if origin != url:
                clone_git_checked(staging, ['remote', 'set-url', 'origin', origin], reason=reason)
            for name, oid in branches:
                clone_git_checked(staging, ['update-ref', 'refs/heads/' + name, oid], reason=reason)
            listed = {name for name, _ in branches}
            for line in clone_git_checked(staging, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/pikibun'], reason=reason).splitlines():
                if line.startswith('refs/pikibun/') or line[len('refs/heads/'):] not in listed:
                    clone_git_checked(staging, ['update-ref', '-d', line], reason=reason)
            if branch is not None:
                clone_git_checked(staging, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch], reason=reason)
            elif head is not None:
                clone_git_checked(staging, ['update-ref', '--no-deref', 'HEAD', head], reason=reason)
            clone_git_checked(staging, ['read-tree', '--reset', '-u', worktree], reason=reason)
            # The index goes back to HEAD, so the backed-up changes show as uncommitted again.
            clone_git_checked(staging, ['read-tree', head] if head else ['read-tree', '--empty'], reason=reason)
            with open(os.path.join(staging, '.git', RESTORED_MARKER), 'w') as handle:
                handle.write(worktree + '\n')
            if os.path.lexists(directory):
                raise ValueError('something else is already at the clone\'s path')
            os.rename(staging, directory)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        save_clone_state(state, remaining)
        os.unlink(marker)
        if bundle is not None:
            try:
                os.unlink(bundle, dir_fd=state)
            except FileNotFoundError:
                pass
    finally:
        if state is not None:
            os.close(state)
        os.close(git)
        os.close(work)


# The search tool (search.ts): mirrors SEARCH_CORE there, line for line, so every backend answers the same; change both
# together. Mirrors searchLimits.
SEARCH_FILE_BYTES = 1024 * 1024
SEARCH_FILES = 20000
SEARCH_BYTES = 64 * 1024 * 1024
SEARCH_LINE_TEXT = 300
SEARCH_SECONDS = 10
SEARCH_TEXT = 256 * 1024


def glob_expression(glob):
    source, index = '', 0
    while index < len(glob):
        char = glob[index]
        if char == '*' and glob[index + 1:index + 2] == '*':
            index += 1
            if glob[index + 1:index + 2] == '/':
                index += 1
                source += '(?:.*/)?'
            else:
                source += '.*'
        elif char == '*':
            source += '[^/]*'
        elif char == '?':
            source += '[^/]'
        else:
            source += re.escape(char)
        index += 1
    return re.compile('^' + source + '$')


def search(root, request):
    pattern, glob = request['pattern'], request.get('glob')
    literal, ignore_case, show_all = request['literal'], request['ignoreCase'], request['all']
    context, max_results = request['context'], request['maxResults']
    if not isinstance(pattern, str) or not pattern or len(pattern) > 1000 or (glob is not None and (not isinstance(glob, str) or len(glob) > 200)) \
            or not all(isinstance(value, bool) for value in (literal, ignore_case, show_all)) \
            or type(context) is not int or not 0 <= context <= 5 or type(max_results) is not int or not 1 <= max_results <= 500:
        raise ValueError('invalid search request')
    try:
        expression = re.compile(re.escape(pattern) if literal else pattern, re.IGNORECASE if ignore_case else 0)
    except re.error:
        raise ValueError('invalid regular expression') from None
    glob_match = None if glob is None else glob_expression(glob)
    glob_path = glob is not None and '/' in glob
    deadline = time.monotonic() + SEARCH_SECONDS
    matches, state = [], {'files': 0, 'bytes': 0, 'characters': 0, 'truncated': False}

    def shown(line):
        return line[:SEARCH_LINE_TEXT] + '\u2026' if len(line) > SEARCH_LINE_TEXT else line

    def done():
        # Stopping with results to spare is stopping early: what lies beyond may hold more matches.
        if len(matches) >= max_results:
            state['truncated'] = True
        return state['truncated']

    def search_file(parent, name, relative, size):
        if size > SEARCH_FILE_BYTES:
            return
        if state['files'] >= SEARCH_FILES or state['bytes'] + size > SEARCH_BYTES or time.monotonic() > deadline:
            state['truncated'] = True
            return
        try:
            data = read_at(parent, name, SEARCH_FILE_BYTES)[0]
        except (OSError, ValueError):
            return
        if b'\0' in data:
            return
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            return
        state['files'] += 1
        state['bytes'] += len(data)
        lines = [line[:-1] if line.endswith('\r') else line for line in text.split('\n')]
        if len(lines) > 1 and lines[-1] == '':
            lines.pop()
        for index, line in enumerate(lines):
            if not expression.search(line):
                continue
            if len(matches) >= max_results:
                state['truncated'] = True
                return
            match = {'path': relative, 'line': index + 1, 'text': shown(line)}
            if context > 0:
                match['before'] = [shown(item) for item in lines[max(0, index - context):index]]
                match['after'] = [shown(item) for item in lines[index + 1:index + 1 + context]]
            size = sum(len(item) for item in [match['text'], *match.get('before', []), *match.get('after', [])])
            if state['characters'] + size > SEARCH_TEXT:
                state['truncated'] = True
                return
            state['characters'] += size
            matches.append(match)

    def visit(directory, prefix):
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            if done():
                return
            if time.monotonic() > deadline:
                state['truncated'] = True
                return
            relative = name if prefix == '.' else prefix + '/' + name
            try:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode):
                continue
            if stat.S_ISDIR(info.st_mode):
                if name == '.git' or (not show_all and name == 'node_modules'):
                    continue
                try:
                    child = os.open(name, DIR_FLAGS, dir_fd=directory)
                except OSError:
                    continue
                try:
                    visit(child, relative)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and (glob_match is None or glob_match.match(relative if glob_path else name)):
                search_file(directory, name, relative, info.st_size)

    path = request['path']
    parts = parts_for(path)
    if not parts:
        visit(root, '.')
    else:
        parent = walk(root, parts[:-1])
        try:
            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('the path is a link')
            if stat.S_ISDIR(info.st_mode):
                directory = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
                try:
                    visit(directory, '/'.join(parts))
                finally:
                    os.close(directory)
            elif stat.S_ISREG(info.st_mode):
                search_file(parent, parts[-1], '/'.join(parts), info.st_size)
            else:
                raise ValueError('the path is not a file or directory')
        finally:
            os.close(parent)
    return {'matches': matches, 'files': state['files'], 'truncated': state['truncated']}


def main():
    # One JSON line.
    request = json.loads(sys.stdin.buffer.readline())
    kind = request['kind']
    limits(request)
    if kind == 'initialize':
        try:
            os.stat(os.path.join(GITDIR or os.path.join(WORK, '.git'), 'HEAD'), follow_symlinks=False)
        except FileNotFoundError:
            if GITDIR is None:
                run(GIT + ['init', '--quiet', '--template=', '--initial-branch=main', WORK])
            else:
                # The runner wrote WORK/.git, which the session can't change, pointing here.
                run(GIT + ['--git-dir=' + GITDIR, 'init', '--quiet', '--template=', '--initial-branch=main'])
                run(GIT + ['--git-dir=' + GITDIR, 'config', 'core.bare', 'false'])
        run(GIT + ['rev-parse', '--is-inside-work-tree'])
        return
    if kind == 'clone-head':
        print(json.dumps(clone_head(request), ensure_ascii=True))
        return
    if kind == 'clone-push-prepare':
        print(json.dumps(clone_push_prepare(request), ensure_ascii=True))
        return
    if kind == 'clone-push-pack':
        clone_push_pack(request)
        return
    if kind == 'clone-backup':
        # A pack's backup replaces the clones (pack.ts), so whatever it can't carry is refused (clone_pack_check).
        pack = request.get('pack', False)
        if not isinstance(pack, bool):
            raise ValueError('invalid clone backup request')
        print(json.dumps(clone_backup(pack), ensure_ascii=True))
        return
    if kind == 'clone-pending':
        print(json.dumps(clone_pending(), ensure_ascii=True))
        return
    if kind == 'clone-restore':
        egress = request.get('egress')
        if egress is not None:
            egress_relay(egress['socket'], int(egress['port']))
        clone_restore(request)
        return
    if kind == 'bash':
        egress = request.get('egress')
        if egress is not None:
            egress_relay(egress['socket'], int(egress['port']))
        run([BASH, '--noprofile', '--norc', '-c', request['command']])
        return
    if kind == 'snapshot':
        print(json.dumps(snapshot(request), ensure_ascii=True))
        return
    root = os.open(WORK, DIR_FLAGS)
    try:
        if kind == 'import':
            print(json.dumps({'path': import_at(root, request)}, ensure_ascii=True))
            return
        if kind == 'search':
            print(json.dumps(search(root, request), ensure_ascii=True))
            return
        if kind in ('move', 'copy', 'delete'):
            print(json.dumps(file_operation(root, request), ensure_ascii=True))
            return
        parts = parts_for(request['path'], kind == 'write')
        if kind == 'write':
            write_at(root, parts, request['content'])
            result = None
        elif kind == 'read' or kind == 'read-content':
            if not parts:
                raise ValueError('a file path is required')
            parent = walk(root, parts[:-1])
            try:
                if kind == 'read':
                    result = read_at(parent, parts[-1], MAX_FILE)[0].decode('utf-8')
                else:
                    data = read_at(parent, parts[-1], MAX_IMAGE)[0]
                    if any(all(data[offset:offset + len(part)] == part for offset, part in signature)
                           for signature in IMAGE_SIGNATURES):
                        result = {'image': base64.b64encode(data).decode('ascii')}
                    elif len(data) > MAX_FILE:
                        raise ValueError('file exceeds size limit')
                    else:
                        result = {'text': data.decode('utf-8')}
            finally:
                os.close(parent)
        elif kind == 'browse':
            if not parts:
                result = browse_directory(root)
            else:
                parent = walk(root, parts[:-1])
                try:
                    info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        directory = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
                        try:
                            result = browse_directory(directory)
                        finally:
                            os.close(directory)
                    else:
                        result = browse_file(parent, parts[-1])
                finally:
                    os.close(parent)
        elif kind == 'list':
            directory = walk(root, parts)
            try:
                names = os.listdir(directory)
                if len(names) > MAX_ENTRIES:
                    raise ValueError('directory has too many entries')
                result = sorted(names)
            finally:
                os.close(directory)
        else:
            raise ValueError('unsupported filesystem operation')
        print(json.dumps(result, ensure_ascii=True))
    finally:
        os.close(root)

try:
    main()
except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
    print('sandbox: ' + str(error), file=sys.stderr)
    sys.exit(1)
