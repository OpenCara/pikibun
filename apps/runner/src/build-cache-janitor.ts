import { spawn } from "node:child_process";

export const BUILD_CACHE_JANITOR = String.raw`
import json, os, stat, sys, time

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
NAME_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-')
DEPTH = 64
ENTRIES = 1000000
STEPS = 10000000
SCAN_COST = 50000000
WINDOW = 128
request = json.loads(sys.argv[1])
seen = [0]
truncated = [False]
counted_out = [False]


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


def walk(fd, prefix, depth, visit, deep=None):
    total = [0, 0, 0.0]
    for name, info in children(fd):
        seen[0] += 1
        if seen[0] > ENTRIES:
            truncated[0] = True
            counted_out[0] = True
            return total
        total[2] = max(total[2], info.st_mtime)
        if stat.S_ISDIR(info.st_mode):
            if depth + 1 >= DEPTH:
                truncated[0] = True
                if deep is not None:
                    deep(prefix + [name], info.st_mtime)
                continue
            try:
                child = open_dir(name, fd)
            except OSError:
                continue
            try:
                inner = walk(child, prefix + [name], depth + 1, visit, deep)
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


def deep_newest(leaf_fd, path):
    newest = 0.0
    stack = [path]
    entries = 0
    cost = 0
    while stack:
        parts = stack.pop()
        cost += len(parts)
        if cost > SCAN_COST:
            return None
        try:
            fd = open_path(leaf_fd, parts)
        except OSError:
            continue
        try:
            newest = max(newest, os.fstat(fd).st_mtime)
            for name, info in children(fd):
                entries += 1
                if entries > ENTRIES:
                    return None
                newest = max(newest, info.st_mtime)
                if stat.S_ISDIR(info.st_mode):
                    stack.append(parts + [name])
        finally:
            os.close(fd)
    return newest


def remove_tree(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=parent)
        return
    below = []
    held = []
    try:
        for _ in range(STEPS):
            if not held or held[-1][0] != len(below):
                reopen(parent, [name] + below, held)
            fd = held[-1][1]
            inner = None
            for child, child_info in children(fd):
                if stat.S_ISDIR(child_info.st_mode):
                    inner = child
                    break
                os.unlink(child, dir_fd=fd)
            if inner is not None:
                below.append(inner)
                held.append((len(below), open_dir(inner, fd)))
                if len(held) > WINDOW:
                    os.close(held.pop(0)[1])
                continue
            os.close(held.pop()[1])
            if not below:
                os.rmdir(name, dir_fd=parent)
                return
            last = below.pop()
            if not held or held[-1][0] != len(below):
                reopen(parent, [name] + below, held)
            os.rmdir(last, dir_fd=held[-1][1])
        raise OSError('the tree kept growing while it was removed')
    finally:
        for _, fd in held:
            os.close(fd)


def reopen(parent, parts, held):
    for _, fd in held:
        os.close(fd)
    del held[:]
    fd = os.dup(parent)
    try:
        for index, part in enumerate(parts):
            following = open_dir(part, fd)
            if held and held[-1][1] == fd:
                pass
            else:
                os.close(fd)
            fd = following
            held.append((index, fd))
            if len(held) > WINDOW:
                os.close(held.pop(0)[1])
        fd = None
    except BaseException:
        if fd is not None and not any(item[1] == fd for item in held):
            os.close(fd)
        for _, item in held:
            os.close(item)
        del held[:]
        raise


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
            counted_out[0] = False
            deep = []
            try:
                usage = walk(fd, [], 0, None, lambda path, mtime: deep.append(path))
                mtime = os.fstat(fd).st_mtime
                newest = max(usage[2], mtime)
                for path in deep:
                    if newest > cutoff:
                        break
                    found = deep_newest(fd, path)
                    newest = max(newest, found) if found is not None else float('inf')
            finally:
                os.close(fd)
            if counted_out[0] or newest > cutoff:
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
        dedicated = request.get('dedicated')
        files = []
        deep = []
        total = 0
        for leaf in leaves(root):
            parts = leaf_parts(leaf)
            try:
                fd = open_path(root, parts)
            except OSError:
                continue
            try:
                usage = walk(fd, [], 0, lambda path, size, mtime, parts=parts: files.append((mtime, size, parts, path)),
                             lambda path, mtime, parts=parts: deep.append((mtime, parts, path)))
            finally:
                os.close(fd)
            total += usage[0]

        def used():
            fs = os.fstatvfs(root)
            return (fs.f_blocks - fs.f_bfree) * fs.f_frsize

        if dedicated:
            total = max(total, used())
        removed = 0
        freed = 0
        if total > capacity * request['evictAt']:
            goal = capacity * request['evictTo']
            deep.sort(key=lambda item: item[0])
            for mtime, parts, path in deep:
                if dedicated and total <= goal:
                    break
                before = used() if dedicated else 0
                try:
                    parent = open_path(root, parts + path[:-1])
                except OSError:
                    continue
                try:
                    remove_tree(parent, path[-1])
                except OSError:
                    continue
                finally:
                    os.close(parent)
                removed += 1
                if dedicated:
                    gone = max(0, before - used())
                    total -= gone
                    freed += gone
            files.sort(key=lambda item: item[0])
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
