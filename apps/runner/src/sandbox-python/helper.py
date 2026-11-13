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

MIRROR_ROOT = '/repository-mirrors'

for fd_name in os.listdir('/proc/self/fd' if os.path.isdir('/proc/self/fd') else '/dev/fd'):
    fd = int(fd_name)
    if fd > 2:
        try:
            os.close(fd)
        except OSError:
            pass
os.umask(0o077)
PUSH_KINDS = ('clone-push-prepare', 'clone-push-pack')
LONG_KINDS = PUSH_KINDS + ('clone-backup', 'clone-restore')


def bounded(which, value):
    hard = resource.getrlimit(which)[1]
    value = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(which, (value, value))


def limits(request):
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
    if kind != 'bash':
        memory = (4096 if push else 512) * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        except (ValueError, OSError):
            if sys.platform != 'darwin':
                raise


HOME = os.environ['HOME']
WORK = os.environ['SANDBOX_WORKTREE']
MAX_FILE = 1024 * 1024
MAX_IMAGE = 16 * 1024 * 1024
IMAGE_SIGNATURES = (
    ((0, b'\x89PNG\r\n\x1a\n'),),
    ((0, b'\xff\xd8\xff'),),
    ((0, b'GIF87a'),),
    ((0, b'GIF89a'),),
    ((0, b'RIFF'), (8, b'WEBP')),
)
MAX_SNAPSHOT = 32 * 1024 * 1024
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
            if not truncated or error.start < len(data) - 3 or error.reason != 'unexpected end of data':
                return {'type': 'file', 'size': size, 'truncated': truncated, 'binary': True}
            content = data[:error.start].decode('utf-8')
        return {'type': 'file', 'size': size, 'truncated': truncated, 'text': content}
    finally:
        os.close(fd)


def import_candidate(name, index):
    if index <= 1:
        return name
    dot = name.rfind('.')
    return '%s (%d)%s' % (name[:dot], index, name[dot:]) if dot > 0 else '%s (%d)' % (name, index)


def import_at(root, request):
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


COPY_ENTRIES = 10000
COPY_BYTES = 50 * 1024 * 1024
OPERATION_DEPTH = 64


def entry_parts(value):
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
            if error.errno in (errno.EPERM, errno.ENOTSUP, errno.EXDEV, errno.EMLINK, errno.ENOSYS):
                raise ValueError('this file system can\'t move a file without risking what appears at its destination: '
                                 'copy it, then delete the original') from None
            raise
        os.unlink(name, dir_fd=source)


def walk_existing(root, parts):
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


PACK_SKIPPED_HOME = ('.tmp', '.cache', '.npm', '.pnpm-store', '.yarn', '.bun', '.local/share/pnpm', '.cargo/registry',
                     '.cargo/git', 'go/pkg/mod', '.m2/repository', '.gradle/caches', '.nuget/packages')


def snapshot(request):
    files, total = [], 0
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
            parent = os.open(os.path.dirname(owner), DIR_FLAGS)
            try:
                add(parent, os.path.basename(owner), 'owner.gitconfig')
            finally:
                os.close(parent)
        visit(work, 'worktree', ('.git',))
        visit(git, 'git', ('pikibun-push', CLONE_STATE))
        return files
    finally:
        os.close(git)
        os.close(work)
        os.close(home)


OID = re.compile('[0-9a-f]{40}')


def clone_directory(request):
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
    child = clone_spawn(directory, ['-c', 'core.bigFileThreshold=64m', 'pack-objects', '--stdout', '--revs',
                                    '--delta-base-offset', '-q'], stdout=None)
    child.communicate((commit + '\n' + ''.join('^' + oid + '\n' for oid in exclude)).encode('ascii'))
    if child.returncode:
        raise ValueError('push pack failed')


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
    return (isinstance(value, str) and 1 <= len(value) <= 200 and value not in ('HEAD', '@') and not value.startswith(('-', 'refs/'))
            and not re.search(r'[\s\x00-\x1f\x7f\\~^:?*[]', value) and not re.search('[\ud800-\udfff]', value)
            and '..' not in value and '@{' not in value and not value.endswith(('.', '/'))
            and not any(not part or part.startswith('.') or part.endswith('.lock') for part in value.split('/')))


def find_clones():
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
    code, output = clone_git(directory, ['rev-list', '--count', '--tags', '--not', '--remotes=origin'])
    if code or output.strip() not in (b'', b'0'):
        raise ValueError('the clone ' + path + ' has tags on commits its origin doesn\'t have, which a pack can\'t keep')


PACK_REBUILDABLE_DIRS = ('node_modules', 'bower_components', '.pnpm-store', '.yarn', '.venv', 'venv', '__pycache__',
                         '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.gradle', 'target', 'dist',
                         'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', 'coverage',
                         '.nyc_output')
PACK_REBUILDABLE_SUFFIXES = ('.pyc', '.pyo', '.log', '.tsbuildinfo')
MAX_PACK_IGNORED_BYTES = 16 * 1024 * 1024
MAX_PACK_IGNORED_FILES = 5000


def pack_ignored_files(directory, path, nested):
    dirs = {os.fsencode(name) for name in PACK_REBUILDABLE_DIRS}
    suffixes = tuple(os.fsencode(suffix) for suffix in PACK_REBUILDABLE_SUFFIXES)
    clones = [os.fsencode(item) for item in nested]
    kept, total = [], 0

    def inside_clone(relative):
        return any(relative == clone or relative.startswith(clone + b'/') for clone in clones)

    def lstat_of(relative):
        try:
            return os.lstat(os.path.join(os.fsencode(directory), relative))
        except FileNotFoundError:
            return None

    def keep(relative, info):
        nonlocal total
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
        elif not stat.S_ISLNK(info.st_mode):
            return
        if len(kept) >= MAX_PACK_IGNORED_FILES:
            raise ValueError('the clone ' + path + ' has too many ignored files to pack')
        if total > MAX_PACK_IGNORED_BYTES:
            raise ValueError('the clone ' + path + ' has ignored files too large to pack')
        kept.append(relative)

    def walk(relative):
        for name in sorted(os.listdir(os.path.join(os.fsencode(directory), relative))):
            child = relative + b'/' + name
            info = None if inside_clone(child) else lstat_of(child)
            if info is None:
                continue
            if stat.S_ISDIR(info.st_mode):
                if name == b'.git':
                    raise ValueError('the clone ' + path + ' has a Git repository among its ignored files, which a pack can\'t keep')
                if name not in dirs:
                    walk(child)
            elif not name.endswith(suffixes):
                keep(child, info)

    code, output = clone_git(directory, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory',
                                         '--no-empty-directory'])
    if code:
        raise ValueError('the clone ' + path + ' could not be backed up')
    for entry in output.split(b'\0'):
        relative = entry.rstrip(b'/')
        parts = relative.split(b'/')
        if not relative or inside_clone(relative) or any(part in dirs for part in parts[:-1]):
            continue
        info = lstat_of(relative)
        if info is None:
            continue
        if stat.S_ISDIR(info.st_mode):
            if parts[-1] not in dirs:
                if os.path.lexists(os.path.join(os.fsencode(directory), relative, b'.git')):
                    raise ValueError('the clone ' + path + ' has a Git repository among its ignored files, which a pack can\'t keep')
                walk(relative)
        elif not parts[-1].endswith(suffixes):
            keep(relative, info)
    return kept


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
    kept = pack_ignored_files(directory, path, nested) if pack else []
    index = os.path.join(directory, '.git', 'pikibun-backup-index')
    extra = dict(BACKUP_IDENTITY, GIT_INDEX_FILE=index)
    try:
        try:
            shutil.copyfile(os.path.join(directory, '.git', 'index'), index, follow_symlinks=False)
        except FileNotFoundError:
            clone_git_checked(directory, ['read-tree', head] if head else ['read-tree', '--empty'], extra=extra, reason=reason)
        no_lfs = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false']
        clone_git_checked(directory, no_lfs + ['add', '-A'], extra=extra, reason=reason)
        if kept:
            clone_git_checked(directory, no_lfs + ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
                              b'\0'.join(kept), extra=extra, reason=reason)
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
    if head is not None and clone_git_checked(directory, ['rev-parse', head + '^{tree}'], reason=reason) == tree:
        worktree = head
    else:
        worktree = clone_git_checked(directory, ['commit-tree', tree] + (['-p', head] if head else []),
                                     b'Pikibun backup of the working tree\n', extra=BACKUP_IDENTITY, reason=reason)
    if not OID.fullmatch(worktree):
        raise ValueError(reason)
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
        staging = os.path.join(parent, '.' + parts[-1] + '.pikibun-restore')
        if os.path.lexists(staging):
            if os.path.islink(staging) or not os.path.isdir(staging):
                raise ValueError('something else is already at the clone\'s path')
            shutil.rmtree(staging)
        env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
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


SEARCH_FILE_BYTES = 1024 * 1024
SEARCH_FILES = 20000
SEARCH_BYTES = 64 * 1024 * 1024
SEARCH_LINE_TEXT = 500
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
        if len(matches) > max_results:
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
            text = data.decode('utf-8-sig')
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
            if len(matches) > max_results:
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

    def below(relative):
        return relative if base == '.' else relative[len(base) + 1:]

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
            elif stat.S_ISREG(info.st_mode) and (glob_match is None or glob_match.match(below(relative) if glob_path else name)):
                search_file(directory, name, relative, info.st_size)

    path = request['path']
    parts = parts_for(path)
    base = '/'.join(parts) or '.'
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
                if request.get('marked') is True:
                    result = []
                    for name in sorted(names):
                        try:
                            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        result.append(name + '/' if stat.S_ISDIR(info.st_mode) else name)
                else:
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
