import { spawn } from "node:child_process";

export const BUILD_CACHE_JANITOR = String.raw`
import json, os, stat, sys, time

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
NAME_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-')
DEPTH = 64
STEPS = 10000000
SCAN_COST = 50000000
WINDOW = 128
request = json.loads(sys.argv[1])
ENTRIES = request.get('entries', 1000000)
NOW = request['now'] / 1000 if 'now' in request else time.time()
seen = [0]
truncated = [False]
counted_out = [False]


def cache_name(name):
    return 0 < len(name) <= 40 and name[0] != '-' and set(name) <= NAME_CHARS


def changed(info):
    return info.st_mtime if info.st_mtime <= NOW else min(info.st_ctime, NOW)


def fair(amount, demands):
    shares = [0] * len(demands)
    left = amount
    order = sorted(range(len(demands)), key=lambda index: demands[index])
    for position, index in enumerate(order):
        shares[index] = min(demands[index], left / (len(order) - position))
        left -= shares[index]
    return shares


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
        total[2] = max(total[2], changed(info))
        if stat.S_ISDIR(info.st_mode):
            if depth + 1 >= DEPTH:
                truncated[0] = True
                if deep is not None:
                    deep(prefix + [name], changed(info))
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
                visit(prefix + [name], size, changed(info))
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
            newest = max(newest, changed(os.fstat(fd)))
            for name, info in children(fd):
                entries += 1
                if entries > ENTRIES:
                    return None
                newest = max(newest, changed(info))
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
            seen[0] = 0
            try:
                usage = walk(fd, [], 0, None)
                mtime = changed(os.fstat(fd))
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
            seen[0] = 0
            deep = []
            try:
                usage = walk(fd, [], 0, None, lambda path, mtime: deep.append(path))
                mtime = changed(os.fstat(fd))
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
        limit = capacity * request['evictAt']
        goal = capacity * request['evictTo']

        def used():
            fs = os.fstatvfs(root)
            return (fs.f_blocks - fs.f_bfree) * fs.f_frsize

        copies = []
        deep = []
        total = used() if dedicated else 0
        if not dedicated or total > limit:
            for leaf in leaves(root):
                parts = leaf_parts(leaf)
                try:
                    fd = open_path(root, parts)
                except OSError:
                    continue
                seen[0] = 0
                counted_out[0] = False
                try:
                    usage = walk(fd, [], 0, None, lambda path, mtime, parts=parts: deep.append((mtime, parts, path)))
                finally:
                    os.close(fd)
                copies.append({'parts': parts, 'bytes': usage[0], 'whole': counted_out[0], 'over': 0})
            if not dedicated:
                total = sum(copy['bytes'] for copy in copies)
        removed = 0
        freed = 0
        if total > limit:
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
            for copy in sorted((copy for copy in copies if copy['whole']), key=lambda copy: -copy['bytes']):
                if total <= goal:
                    break
                before = used() if dedicated else 0
                try:
                    fd = open_path(root, copy['parts'])
                except OSError:
                    continue
                try:
                    for name, _ in children(fd):
                        remove_tree(fd, name)
                except OSError:
                    continue
                finally:
                    os.close(fd)
                gone = max(0, before - used()) if dedicated else copy['bytes']
                total -= gone
                freed += gone
                removed += 1
            sized = [copy for copy in copies if not copy['whole']]
            if total > goal:
                room = max(0, goal - max(0, total - sum(copy['bytes'] for copy in sized)))
                groups = {}
                for copy in sized:
                    groups.setdefault(copy['parts'][0], []).append(copy)
                names = sorted(groups)
                rooms = fair(room, [sum(copy['bytes'] for copy in groups[name]) for name in names])
                for name, share in zip(names, rooms):
                    for copy, part in zip(groups[name], fair(share, [copy['bytes'] for copy in groups[name]])):
                        copy['over'] = copy['bytes'] - part
                for copy in sorted(sized, key=lambda copy: -copy['over']):
                    over = copy['over']
                    if over < 1 or total <= goal:
                        break
                    try:
                        fd = open_path(root, copy['parts'])
                    except OSError:
                        continue
                    files = []
                    seen[0] = 0
                    try:
                        walk(fd, [], 0, lambda path, size, mtime: files.append((mtime, path, size)))
                        files.sort()
                        for mtime, path, size in files:
                            if over < 1 or total <= goal:
                                break
                            try:
                                if not unlink_at(fd, path):
                                    continue
                            except OSError:
                                continue
                            over -= size
                            total -= size
                            freed += size
                            removed += 1
                    finally:
                        os.close(fd)
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
