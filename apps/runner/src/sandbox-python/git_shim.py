#!/usr/bin/python3 -I
# The sandbox's git shim (see GIT_SHIM in apps/runner/src/sandbox.ts), embedded in the connector through
# sandbox-python.generated.ts (`pnpm python:embed` writes it; tests/sandbox-python.test.ts checks it is current).
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# egress.ts EGRESS_PORT and sandbox.ts GIT_LFS_PATHS (tests/sandbox-python.test.ts checks them).
EGRESS_PORT = 41080
GIT_LFS_PATHS = ('/usr/bin/git-lfs', '/usr/local/bin/git-lfs')

args = sys.argv[1:]
VALUED = {'-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--template', '-c', '--config', '--depth', '--shallow-since',
          '--shallow-exclude', '--separate-git-dir', '-j', '--jobs', '--filter', '--bundle-uri', '--server-option', '--ref-format',
          '--reference', '--reference-if-able', '--revision'}


LFS = next((path for path in GIT_LFS_PATHS if os.access(path, os.X_OK)), None)


def endpoint(name, url, timeout):
    query = urllib.parse.urlencode({'remote': url})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open('http://127.0.0.1:' + str(EGRESS_PORT) + '/__pikibun/' + name + '?' + query, timeout=timeout)


def ask(name, url, timeout):
    try:
        with endpoint(name, url, timeout) as response:
            answer = json.load(response)
            return answer if isinstance(answer, dict) else {}
    except Exception:
        return {}


def note(text):
    try:
        sys.stderr.write('pikibun: ' + text + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def described(progress):
    phase = progress.get('phase')
    text = phase if isinstance(phase, str) and phase.isalpha() else 'filling'
    percent = progress.get('percent')
    if type(percent) is int:
        text += ' %d%%' % percent
    count = progress.get('bytes')
    if type(count) is int and count > 0:
        size, unit = float(count), 'bytes'
        for bigger in ('KiB', 'MiB', 'GiB'):
            if size < 1024:
                break
            size, unit = size / 1024, bigger
        text += ', %s received' % ('%d bytes' % count if unit == 'bytes' else '%.1f %s' % (size, unit))
    return text


def mirror(url):
    # The host's mirror of a workspace repository once it is ready to borrow from, however long its fill takes; None where
    # the host keeps no mirror of the repository, or can't fill it at all. The proxy streams one JSON object per line, with
    # a heartbeat. A connection that drops while the fill goes on is asked again, which joins it; a failure that may pass,
    # or a proxy that doesn't answer, is asked again twice more. Then the clone stops, to be run again, rather than
    # downloading the repository without the cache.
    started, shown, failures, reason = time.monotonic(), None, 0, 'it did not answer'
    while True:
        progressed = transient = False
        try:
            with endpoint('mirror', url, 120) as response:
                for line in response:
                    try:
                        answer = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(answer, dict):
                        continue
                    path = answer.get('path')
                    if isinstance(path, str) and path:
                        if shown is not None:
                            note('the repository cache is ready; cloning from it')
                        return path
                    if 'error' in answer:
                        reason = str(answer['error'])[:300]
                        if answer.get('retry') is not True:
                            note('the host cannot fill its repository cache (%s); cloning without it' % reason)
                            return None
                        transient = True
                        break
                    progressed = True
                    progress, now = answer.get('progress'), time.monotonic()
                    if isinstance(progress, dict) and now - started >= 3 and (shown is None or now - shown >= 30):
                        if shown is None:
                            note('waiting for the host to fill its repository cache of ' + url + ': it downloads the repository once,'
                                 ' then every clone borrows from it, and it goes on if this command stops')
                        note('repository cache: ' + described(progress))
                        shown = now
        except urllib.error.HTTPError:
            # No repository cache on this host, or not one of the workspace's repositories: a clone as any other.
            return None
        except Exception:
            reason = 'it did not answer'
        failures = failures + 1 if transient or not progressed else 0
        if failures >= 3:
            note('the repository cache of ' + url + ' is not available right now (%s); run the clone again' % reason)
            sys.exit(128)
        time.sleep(failures or 1)


index = 0
while index < len(args) and args[index].startswith('-'):
    index += 2 if args[index] in ('-C', '-c') else 1
if index < len(args) and args[index] == 'clone':
    rest = args[index + 1:]
    position, url = 0, None
    while position < len(rest):
        argument = rest[position]
        if argument == '--':
            url = rest[position + 1] if position + 1 < len(rest) else None
            break
        if argument.startswith('-'):
            position += 2 if argument in VALUED else 1
            continue
        url = argument
        break
    borrowing = any(argument.startswith('--reference') or argument in ('-s', '--shared', '--dissociate') for argument in rest)
    extra = []
    if url and not borrowing:
        path = mirror(url)
        if path and not os.path.isdir(path):
            # Mounted from the next command on: cloning without it would download the whole repository again.
            note('the repository cache of ' + url + ' is ready, but this command started before it could see it; run the clone again')
            sys.exit(128)
        if path:
            extra += ['--reference-if-able', path]
    if url and LFS and ask('lfs', url, 10).get('lfs') is True:
        extra += ['-c', 'filter.lfs.process=' + LFS + ' filter-process', '-c', 'filter.lfs.smudge=' + LFS + ' smudge -- %f',
                  '-c', 'filter.lfs.clean=' + LFS + ' clean -- %f', '-c', 'filter.lfs.required=true']
    args = args[:index + 1] + extra + rest
os.execv('/usr/bin/git', ['git'] + args)
