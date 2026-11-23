import { spawn } from "node:child_process";

export const BUILD_CACHE_JANITOR = String.raw`
import json, os, stat, sys, time

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
NAME_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-')
DEPTH = 64
ENTRIES = 1000000
request = json.loads(sys.argv[1])
seen = [0]
truncated = [False]


def cache_name(name):
    return 0 < len(name) <= 40 and name[0] != '-' and set(name) <= NAME_CHARS


def open_dir(name, parent):
    return os.open(name, DIR, dir_fd=parent)


def children(fd):
    try:
        with os.scandir(fd) as entries:
            return [(entry.name, entry.stat(follow_symlinks=False)) for entry in entries]
    except OSError:
        return []


def subdirs(fd):
    return sorted(name for name, info in children(fd) if stat.S_ISDIR(info.st_mode))


def leaves(root):
    found = []
    for workspace in subdirs(root):
        try:
            wfd = open_dir(workspace, root)
        except OSError:
            continue
        try:
            for name in subdirs(wfd):
                if not cache_name(name):
                    continue
                try:
                    cfd = open_dir(name, wfd)
                except OSError:
                    continue
                try:
                    kinds = subdirs(cfd)
                    if 'shared' in kinds:
                        found.append((workspace, name, 'shared', None))
                    if 'owners' in kinds:
                        try:
                            ofd = open_dir('owners', cfd)
                        except OSError:
                            continue
                        try:
                            for owner in subdirs(ofd):
                                found.append((workspace, name, 'owner', owner))
                        finally:
                            os.close(ofd)
                finally:
                    os.close(cfd)
        finally:
            os.close(wfd)
    return found


def leaf_parts(leaf):
    workspace, name, scope, owner = leaf
    return [workspace, name, 'shared'] if scope == 'shared' else [workspace, name, 'owners', owner]


def open_path(root, parts):
    fd = os.dup(root)
    try:
        for part in parts:
            following = open_dir(part, fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def walk(fd, prefix, depth, visit):
    total = [0, 0, 0.0]
    for name, info in children(fd):
        seen[0] += 1
        if seen[0] > ENTRIES:
            truncated[0] = True
            return total
        total[2] = max(total[2], info.st_mtime)
        if stat.S_ISDIR(info.st_mode):
            if depth + 1 >= DEPTH:
                truncated[0] = True
                continue
            try:
                child = open_dir(name, fd)
            except OSError:
                continue
            try:
                inner = walk(child, prefix + [name], depth + 1, visit)
            finally:
                os.close(child)
            total[0] += inner[0]
            total[1] += inner[1]
            total[2] = max(total[2], inner[2])
        else:
            size = info.st_size if stat.S_ISREG(info.st_mode) else 0
            total[0] += size
            total[1] += 1
            if visit is not None:
                visit(prefix + [name], size, info.st_mtime)
    return total


def remove_tree(parent, name, depth=0):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=parent)
        return
    if depth >= DEPTH:
        raise OSError('too deep to remove')
    fd = open_dir(name, parent)
    try:
        for child, _ in children(fd):
            remove_tree(fd, child, depth + 1)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)


def unlink_at(leaf_fd, parts):
    fd = open_path(leaf_fd, parts[:-1])
    try:
        info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            return False
        os.unlink(parts[-1], dir_fd=fd)
        return True
    finally:
        os.close(fd)


def remove_empty(root):
    for workspace in subdirs(root):
        try:
            wfd = open_dir(workspace, root)
        except OSError:
            continue
        try:
            for name in subdirs(wfd):
                try:
                    cfd = open_dir(name, wfd)
                except OSError:
                    continue
                try:
                    try:
                        os.rmdir('owners', dir_fd=cfd)
                    except OSError:
                        pass
                finally:
                    os.close(cfd)
                try:
                    os.rmdir(name, dir_fd=wfd)
                except OSError:
                    pass
        finally:
            os.close(wfd)
        try:
            os.rmdir(workspace, dir_fd=root)
        except OSError:
            pass


root = os.open(request['root'], DIR)
try:
    info = os.fstat(root)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('the build cache root must be private to the connector user')
    mode = request['mode']
    if mode == 'list':
        result = []
        for leaf in leaves(root):
            try:
                fd = open_path(root, leaf_parts(leaf))
            except OSError:
                continue
            try:
                usage = walk(fd, [], 0, None)
                mtime = os.fstat(fd).st_mtime
            finally:
                os.close(fd)
            workspace, name, scope, owner = leaf
            item = {'workspace': workspace, 'name': name, 'scope': scope, 'bytes': usage[0], 'files': usage[1], 'newest': max(usage[2], mtime) * 1000}
            if owner is not None:
                item['owner'] = owner
            result.append(item)
        print(json.dumps({'caches': result, 'truncated': truncated[0]}))
    elif mode == 'prune':
        cutoff = request['now'] / 1000 - request['olderThan'] / 1000
        removed = 0
        freed = 0
        for leaf in leaves(root):
            parts = leaf_parts(leaf)
            try:
                fd = open_path(root, parts)
            except OSError:
                continue
            before = truncated[0]
            truncated[0] = False
            try:
                usage = walk(fd, [], 0, None)
                mtime = os.fstat(fd).st_mtime
            finally:
                os.close(fd)
            cut = truncated[0]
            truncated[0] = before or cut
            if cut or max(usage[2], mtime) > cutoff:
                continue
            parent = open_path(root, parts[:-1])
            try:
                remove_tree(parent, parts[-1])
            except OSError:
                continue
            finally:
                os.close(parent)
            removed += 1
            freed += usage[0]
        remove_empty(root)
        print(json.dumps({'removed': removed, 'bytes': freed, 'truncated': truncated[0]}))
    elif mode == 'evict':
        capacity = request['capacity']
        files = []
        total = 0
        for leaf in leaves(root):
            parts = leaf_parts(leaf)
            try:
                fd = open_path(root, parts)
            except OSError:
                continue
            try:
                usage = walk(fd, [], 0, lambda path, size, mtime, parts=parts: files.append((mtime, size, parts, path)))
            finally:
                os.close(fd)
            total += usage[0]
        if request.get('dedicated'):
            fs = os.fstatvfs(root)
            total = max(total, (fs.f_blocks - fs.f_bfree) * fs.f_frsize)
        removed = 0
        freed = 0
        if total > capacity * request['evictAt']:
            files.sort(key=lambda item: item[0])
            goal = capacity * request['evictTo']
            for mtime, size, parts, path in files:
                if total <= goal:
                    break
                try:
                    leaf_fd = open_path(root, parts)
                except OSError:
                    continue
                try:
                    if not unlink_at(leaf_fd, path):
                        continue
                except OSError:
                    continue
                finally:
                    os.close(leaf_fd)
                total -= size
                freed += size
                removed += 1
        print(json.dumps({'removed': removed, 'bytes': freed, 'truncated': truncated[0]}))
    else:
        raise RuntimeError('unknown janitor mode')
finally:
    os.close(root)
`;

const OUTPUT_LIMIT = 16 * 1024 * 1024;

export async function runBuildCacheJanitor(request: Record<string, unknown>, options: { python?: string; timeoutMs?: number } = {}): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.python ?? "/usr/bin/python3", ["-I", "-c", BUILD_CACHE_JANITOR, JSON.stringify(request)], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let message = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { child.kill("SIGKILL"); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (message.length < 4096) message += chunk.toString("utf8").slice(0, 4096 - message.length); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(message.trim().split("\n").pop() || "The build cache janitor failed")); return; }
      try { resolveResult(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { reject(new Error("The build cache janitor answered nonsense")); }
    });
  });
}
