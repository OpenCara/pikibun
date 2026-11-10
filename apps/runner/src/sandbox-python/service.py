#!/usr/bin/python3 -I
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

NODE_PROGRAMS = ('node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack')
NODE_ENVIRONMENT = 'NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true'
PYTHON_PROGRAMS = ('python3', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pytest')
PYTHON_ENVIRONMENT = 'NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1'
MARK = '\x1epikibun-service '
MAX_CONNECTIONS = 256
RELAY_DRAIN_SECONDS = 60


class ServiceError(Exception):
    pass


def notice(kind: str, **fields: Any) -> None:
    sys.stdout.write(MARK + json.dumps(dict(fields, kind=kind), ensure_ascii=True) + '\n')
    sys.stdout.flush()


def launch(spec: Dict[str, Any], node_bin: Optional[str]) -> Tuple[List[str], str, Dict[str, str]]:
    program = spec.get('program')
    directory = os.path.abspath(spec.get('directory') or '.')
    env = dict(os.environ)
    first: List[str] = []
    if program in NODE_PROGRAMS:
        fixed = NODE_ENVIRONMENT
        if node_bin:
            first.append(node_bin)
    elif program in PYTHON_PROGRAMS:
        fixed = PYTHON_ENVIRONMENT
        if spec.get('venv'):
            venv = os.path.join(directory, spec['venv'])
            first.append(os.path.join(venv, 'bin'))
            env['VIRTUAL_ENV'] = venv
    else:
        raise ServiceError('serve runs one of ' + ', '.join(NODE_PROGRAMS + PYTHON_PROGRAMS) + ', not ' + str(program))
    for item in fixed.split():
        name, value = item.split('=', 1)
        env[name] = value
    env['PATH'] = ':'.join(first + [os.environ.get('PATH') or '/usr/bin:/bin', '/usr/local/bin'])
    return [str(program)] + [str(arg) for arg in spec.get('args') or []], directory, env


def port_open(port: int) -> bool:
    return connect(port, 0.5) is not None


def connect(port: int, timeout: Optional[float] = None) -> Optional[socket.socket]:
    for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        try:
            upstream = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue
        try:
            upstream.settimeout(timeout if timeout is not None else 10)
            upstream.connect((address, port))
            upstream.settimeout(None)
            return upstream
        except OSError:
            upstream.close()
    return None


def stop_group(process: 'subprocess.Popen[bytes]') -> None:
    for sent in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sent)
        except OSError:
            return
        try:
            process.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            continue


def copy_output(process: 'subprocess.Popen[bytes]') -> None:
    stream = process.stdout
    if stream is None:
        return
    for line in iter(stream.readline, b''):
        text = line.decode('utf-8', 'replace').rstrip('\n')
        sys.stdout.write(text.replace('\x1e', ' ') + '\n')
        sys.stdout.flush()


def pump(source: socket.socket, target: socket.socket) -> None:
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


def relay(client: socket.socket, port: int, slots: threading.Semaphore) -> None:
    try:
        upstream = connect(port)
        if upstream is None:
            return
        back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        back.start()
        pump(client, upstream)
        back.join(RELAY_DRAIN_SECONDS)
        for end in (upstream, client):
            try:
                end.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        back.join(5)
        upstream.close()
    finally:
        client.close()
        slots.release()


def listen(path: str, port: int) -> socket.socket:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    os.chmod(path, 0o600)
    listener.listen(64)
    slots = threading.Semaphore(MAX_CONNECTIONS)

    def accept() -> None:
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return
            slots.acquire()
            threading.Thread(target=relay, args=(client, port, slots), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return listener


def main() -> int:
    args = sys.argv[1:]
    socket_path = None
    node_bin = None
    while len(args) > 1 and args[0] in ('--socket', '--node-bin'):
        if args[0] == '--socket':
            socket_path = args[1]
        else:
            node_bin = args[1]
        args = args[2:]
    if len(args) != 1 or not socket_path:
        notice('error', message="usage: pikibun-service --socket <path> [--node-bin <directory>] '<serve as JSON>'")
        return 2
    try:
        spec = json.loads(args[0])
        if not isinstance(spec, dict) or type(spec.get('port')) is not int or not 0 < spec['port'] < 65536:
            raise ValueError('serve names its port')
        argv, directory, env = launch(spec, node_bin)
    except (ValueError, ServiceError) as error:
        notice('error', message=str(error))
        return 2
    port = spec['port']
    try:
        process = subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as error:
        notice('error', message='could not start %s: %s' % (argv[0], error.strerror or error))
        return 1
    stopping: List[bool] = []

    def stop(_signal: int, _frame: Any) -> None:
        stopping.append(True)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    copier = threading.Thread(target=copy_output, args=(process,), daemon=True)
    copier.start()
    wait = spec.get('timeout_seconds', 60)
    until = time.monotonic() + wait
    while not port_open(port):
        if process.poll() is not None:
            copier.join(2)
            notice('error', message='%s exited (%s) before port %d answered' % (argv[0], process.returncode, port))
            return 1
        if time.monotonic() >= until or stopping:
            stop_group(process)
            copier.join(2)
            notice('error', message='port %d did not answer within %d seconds of %s starting' % (port, wait, argv[0]))
            return 1
        time.sleep(0.2)
    try:
        listener = listen(socket_path, port)
    except OSError as error:
        stop_group(process)
        notice('error', message='could not listen for the tunnel: %s' % (error.strerror or error))
        return 1
    notice('ready', port=port)
    while process.poll() is None:
        if stopping:
            stop_group(process)
            break
        time.sleep(0.2)
    code = process.wait()
    copier.join(2)
    listener.close()
    notice('exited', code=code)
    return 0 if stopping else (code if code > 0 else 128 - code)


if __name__ == '__main__':
    sys.exit(main())
