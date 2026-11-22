#!/usr/bin/python3 -I
import base64
import hashlib
import http.server
import os
import posixpath
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

VIEWER_DIRECTORIES = ('/usr/share/novnc', '/usr/share/webapps/novnc', '/usr/share/noVNC', '/usr/local/share/novnc')
VIEWER_PAGE = 'vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000&path=websockify'
WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_VIEWERS = 16
MAX_FRAME = 16 * 1024 * 1024
DISPLAY_WAIT_SECONDS = 30
DISPLAY_ATTEMPTS = 5
IDLE_SECONDS = 90
SIZE_LIMITS = (320, 240, 3840, 2160)
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
}
FONTS_CONF = '''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir>{cache}</cachedir>
{includes}
</fontconfig>
'''
FONT_RULES = ('30-metric-aliases.conf', '40-nonlatin.conf', '45-generic.conf', '45-latin.conf', '49-sansserif.conf',
              '60-generic.conf', '60-latin.conf', '65-nonlatin.conf')
XVNC_PACKAGES = ('TigerVNC\'s Xvnc: tigervnc-standalone-server on Debian and Ubuntu, tigervnc-server-minimal on Fedora, '
                 'tigervnc on Arch')
VIEWER_PACKAGES = 'noVNC\'s files: the novnc package (Debian, Ubuntu, Fedora, Arch)'


class DesktopError(Exception):
    pass


def say(message: str) -> None:
    sys.stdout.write('pikibun-desktop: ' + message + '\n')
    sys.stdout.flush()


USAGE = 'usage: pikibun-desktop --port <port> [--size <width>x<height>] [--web <directory>] [--idle <seconds>] -- <program> [args...]'


def parse(arguments: List[str]) -> Tuple[int, Tuple[int, int], Optional[str], float, List[str]]:
    port = 0
    size = (1280, 800)
    web: Optional[str] = None
    idle = float(IDLE_SECONDS)
    rest = list(arguments)
    while rest and rest[0] != '--':
        if len(rest) < 2:
            raise DesktopError(USAGE)
        name, value = rest[0], rest[1]
        rest = rest[2:]
        if name == '--port' and value.isdigit() and 0 < int(value) < 65536:
            port = int(value)
        elif name == '--size':
            parts = value.split('x')
            if len(parts) != 2 or not all(part.isdigit() for part in parts):
                raise DesktopError('the size is <width>x<height>, such as 1280x800')
            width, height = int(parts[0]), int(parts[1])
            if not (SIZE_LIMITS[0] <= width <= SIZE_LIMITS[2] and SIZE_LIMITS[1] <= height <= SIZE_LIMITS[3]):
                raise DesktopError('a desktop is from %dx%d to %dx%d' % SIZE_LIMITS)
            size = (width, height)
        elif name == '--web':
            web = value
        elif name == '--idle' and value.isdigit() and 0 < int(value) <= 3600:
            idle = float(value)
        else:
            raise DesktopError('unknown option ' + name)
    if not rest or rest[0] != '--' or len(rest) < 2 or not port:
        raise DesktopError(USAGE)
    return port, size, web, idle, rest[1:]


def viewer_directory(given: Optional[str]) -> str:
    for directory in ([given] if given else list(VIEWER_DIRECTORIES)):
        if os.path.isfile(os.path.join(directory, 'vnc.html')) and os.path.isfile(os.path.join(directory, 'core', 'rfb.js')):
            return os.path.realpath(directory)
    raise DesktopError('a desktop needs ' + VIEWER_PACKAGES + ', which the host lacks: its owner installs it')


def find_xvnc(env: Dict[str, str]) -> str:
    found = shutil.which('Xvnc', path=env.get('PATH') or '/usr/bin:/bin')
    if not found:
        raise DesktopError('a desktop needs ' + XVNC_PACKAGES + ', which the host lacks: its owner installs it')
    return found


def free_display(first: int) -> int:
    for number in range(first, 200):
        if not os.path.exists('/tmp/.X11-unix/X%d' % number) and not os.path.exists('/tmp/.X%d-lock' % number):
            return number
    raise DesktopError('no free display number')


def free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(('127.0.0.1', 0))
        return int(probe.getsockname()[1])
    finally:
        probe.close()


def answers(port: int) -> bool:
    try:
        connection = socket.create_connection(('127.0.0.1', port), 0.5)
    except OSError:
        return False
    connection.close()
    return True


def fonts_config() -> Optional[str]:
    if os.path.exists('/etc/fonts/fonts.conf'):
        return None
    temporary = os.environ.get('TMPDIR') or '/tmp'
    cache = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.join(os.environ.get('HOME', '.'), '.cache'), 'fontconfig')
    rules = [os.path.join('/usr/share/fontconfig/conf.avail', name) for name in FONT_RULES]
    includes = '\n'.join('  <include ignore_missing="yes">' + path + '</include>' for path in rules if os.path.exists(path))
    os.makedirs(temporary, exist_ok=True)
    path = os.path.join(temporary, 'pikibun-desktop-fonts.conf')
    with open(path, 'w') as handle:
        handle.write(FONTS_CONF.format(cache=cache, includes=includes))
    return path


def program_environment(display: int) -> Dict[str, str]:
    env = dict(os.environ)
    env['DISPLAY'] = ':%d' % display
    for name in ('WAYLAND_DISPLAY', 'WAYLAND_SOCKET'):
        env.pop(name, None)
    env.setdefault('GDK_BACKEND', 'x11')
    env.setdefault('QT_QPA_PLATFORM', 'xcb')
    env.setdefault('SDL_VIDEODRIVER', 'x11')
    runtime = os.path.join(os.environ.get('TMPDIR') or '/tmp', 'pikibun-desktop-%d' % display)
    os.makedirs(runtime, mode=0o700, exist_ok=True)
    env.setdefault('XDG_RUNTIME_DIR', runtime)
    fonts = fonts_config()
    if fonts:
        env['FONTCONFIG_FILE'] = fonts
    return env


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode('ascii')).digest()).decode('ascii')


def frame(opcode: int, payload: bytes) -> bytes:
    length = len(payload)
    if length < 126:
        head = struct.pack('!BB', 0x80 | opcode, length)
    elif length < 65536:
        head = struct.pack('!BBH', 0x80 | opcode, 126, length)
    else:
        head = struct.pack('!BBQ', 0x80 | opcode, 127, length)
    return head + payload


def read_exactly(stream: Any, count: int) -> bytes:
    chunks: List[bytes] = []
    while count > 0:
        chunk = stream.read(count)
        if not chunk:
            raise EOFError()
        chunks.append(chunk)
        count -= len(chunk)
    return b''.join(chunks)


def read_frame(stream: Any) -> Tuple[int, bytes]:
    first, second = struct.unpack('!BB', read_exactly(stream, 2))
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack('!H', read_exactly(stream, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', read_exactly(stream, 8))[0]
    if not second & 0x80:
        raise EOFError()
    if length > MAX_FRAME:
        raise EOFError()
    mask = read_exactly(stream, 4)
    data = bytearray(read_exactly(stream, length))
    for index in range(length):
        data[index] ^= mask[index % 4]
    return opcode, bytes(data)


class Bridge:
    def __init__(self, handler: http.server.BaseHTTPRequestHandler, rfb_port: int, idle: float):
        self.handler = handler
        self.rfb_port = rfb_port
        self.idle = idle
        self.heard = time.monotonic()
        self.lock = threading.Lock()
        self.closed = threading.Event()

    def send(self, opcode: int, payload: bytes) -> None:
        with self.lock:
            self.handler.connection.sendall(frame(opcode, payload))

    def from_display(self, display: socket.socket) -> None:
        try:
            while not self.closed.is_set():
                data = display.recv(65536)
                if not data:
                    break
                self.send(0x2, data)
        except OSError:
            pass
        finally:
            self.close(display)

    def keep_alive(self, display: socket.socket) -> None:
        while not self.closed.wait(self.idle / 3):
            if time.monotonic() - self.heard > self.idle:
                self.close(display)
                return
            try:
                self.send(0x9, b'pikibun')
            except OSError:
                self.close(display)
                return

    def close(self, display: socket.socket) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        try:
            self.send(0x8, struct.pack('!H', 1000))
        except OSError:
            pass
        for end in (display, self.handler.connection):
            try:
                end.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def run(self) -> None:
        try:
            display = socket.create_connection(('127.0.0.1', self.rfb_port), 10)
        except OSError:
            self.send(0x8, struct.pack('!H', 1011))
            return
        display.settimeout(None)
        threading.Thread(target=self.from_display, args=(display,), daemon=True).start()
        threading.Thread(target=self.keep_alive, args=(display,), daemon=True).start()
        try:
            while not self.closed.is_set():
                opcode, payload = read_frame(self.handler.rfile)
                self.heard = time.monotonic()
                if opcode in (0x0, 0x1, 0x2):
                    display.sendall(payload)
                elif opcode == 0x9:
                    self.send(0xA, payload)
                elif opcode == 0x8:
                    break
        except (EOFError, OSError, struct.error):
            pass
        finally:
            self.close(display)
            display.close()


def handler_for(root: str, rfb_port: int, viewers: threading.Semaphore, idle: float) -> Any:
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'pikibun-desktop'
        sys_version = ''

        def log_message(self, format: str, *args: Any) -> None:
            pass

        def answer(self, status: int, body: bytes = b'', headers: Optional[Dict[str, str]] = None, head: bool = False) -> None:
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def upgrade(self) -> None:
            key = self.headers.get('Sec-WebSocket-Key', '')
            offered = [item.strip() for item in self.headers.get('Sec-WebSocket-Protocol', '').split(',') if item.strip()]
            if not key or self.headers.get('Sec-WebSocket-Version', '') != '13' or (offered and 'binary' not in offered):
                self.answer(400, b'A WebSocket of version 13, binary\n', {'Content-Type': 'text/plain; charset=utf-8'})
                return
            if not viewers.acquire(blocking=False):
                self.answer(503, b'Too many viewers\n', {'Content-Type': 'text/plain; charset=utf-8'})
                return
            try:
                self.send_response(101)
                self.send_header('Upgrade', 'websocket')
                self.send_header('Connection', 'Upgrade')
                self.send_header('Sec-WebSocket-Accept', accept_key(key))
                if offered:
                    self.send_header('Sec-WebSocket-Protocol', 'binary')
                self.end_headers()
                self.wfile.flush()
                Bridge(self, rfb_port, idle).run()
            finally:
                viewers.release()
                self.close_connection = True

        def serve(self, head: bool) -> None:
            path = urllib.parse.urlsplit(self.path).path
            if path == '/' or path == '':
                self.answer(302, b'', {'Location': VIEWER_PAGE}, head)
                return
            if path.rstrip('/') == '/websockify' and 'websocket' in self.headers.get('Upgrade', '').lower() and not head:
                self.upgrade()
                return
            relative = posixpath.normpath('/' + urllib.parse.unquote(path)).lstrip('/')
            target = os.path.join(root, relative)
            if not relative or relative.startswith('..') or '\x00' in relative or not os.path.isfile(target):
                self.answer(404, b'Not found\n', {'Content-Type': 'text/plain; charset=utf-8'}, head)
                return
            try:
                with open(target, 'rb') as handle:
                    body = handle.read()
            except OSError:
                self.answer(404, b'Not found\n', {'Content-Type': 'text/plain; charset=utf-8'}, head)
                return
            kind = CONTENT_TYPES.get(os.path.splitext(target)[1].lower(), 'application/octet-stream')
            self.answer(200, body, {'Content-Type': kind}, head)

        def do_GET(self) -> None:
            self.serve(False)

        def do_HEAD(self) -> None:
            self.serve(True)

    return Handler


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        self.server_name = 'localhost'
        self.server_port = int(self.server_address[1])


class Server6(Server):
    address_family = socket.AF_INET6


def serve(port: int, root: str, rfb_port: int, idle: float) -> List[http.server.HTTPServer]:
    viewers = threading.Semaphore(MAX_VIEWERS)
    handler = handler_for(root, rfb_port, viewers, idle)
    servers: List[http.server.HTTPServer] = [Server(('127.0.0.1', port), handler)]
    try:
        servers.append(Server6(('::1', port), handler))
    except OSError:
        pass
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return servers


def stop(process: Optional['subprocess.Popen[bytes]']) -> None:
    if process is None or process.poll() is not None:
        return
    for sent in (signal.SIGTERM, signal.SIGKILL):
        try:
            process.send_signal(sent)
        except OSError:
            return
        try:
            process.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            continue


def start_display(xvnc: str, size: Tuple[int, int], stopping: List[bool]) -> Tuple['subprocess.Popen[bytes]', int, int]:
    first = 1
    for _attempt in range(DISPLAY_ATTEMPTS):
        display = free_display(first)
        rfb_port = free_port()
        server_args = [xvnc, ':%d' % display, '-geometry', '%dx%d' % size, '-depth', '24', '-rfbport', str(rfb_port), '-localhost',
                       '-SecurityTypes', 'None', '-AlwaysShared', '-nolisten', 'tcp', '-desktop', 'Pikibun']
        try:
            server_process = subprocess.Popen(server_args, stdin=subprocess.DEVNULL)
        except OSError as error:
            raise DesktopError('could not start Xvnc: %s' % (error.strerror or error)) from error
        until = time.monotonic() + DISPLAY_WAIT_SECONDS
        while not answers(rfb_port):
            if server_process.poll() is not None:
                break
            if stopping or time.monotonic() >= until:
                stop(server_process)
                raise DesktopError('Xvnc\'s display was not ready within %d seconds' % DISPLAY_WAIT_SECONDS)
            time.sleep(0.1)
        else:
            return server_process, display, rfb_port
        say('Xvnc exited (%s) before display :%d was ready: another desktop may have taken it; trying the next display'
            % (server_process.returncode, display))
        first = display + 1
    raise DesktopError('Xvnc could not start a display in %d attempts' % DISPLAY_ATTEMPTS)


def main() -> int:
    try:
        port, size, web, idle, argv = parse(sys.argv[1:])
        root = viewer_directory(web)
        env = dict(os.environ)
        xvnc = find_xvnc(env)
    except DesktopError as error:
        say(str(error))
        return 2
    stopping: List[bool] = []

    def stopped(_signal: int, _frame: Any) -> None:
        stopping.append(True)

    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    try:
        server_process, display, rfb_port = start_display(xvnc, size, stopping)
    except DesktopError as error:
        say(str(error))
        return 1
    program: Optional['subprocess.Popen[bytes]'] = None
    servers: List[http.server.HTTPServer] = []
    try:
        try:
            program = subprocess.Popen(argv, env=program_environment(display), stdin=subprocess.DEVNULL)
        except OSError as error:
            say('could not start %s: %s' % (argv[0], error.strerror or error))
            return 1
        try:
            servers = serve(port, root, rfb_port, idle)
        except OSError as error:
            say('could not listen on port %d: %s' % (port, error.strerror or error))
            return 1
        say('display :%d (%dx%d) is on port %d' % (display, size[0], size[1], port))
        while not stopping:
            if program.poll() is not None:
                say('%s exited (%s): the desktop closes' % (argv[0], program.returncode))
                return program.returncode if program.returncode >= 0 else 128 - program.returncode
            if server_process.poll() is not None:
                say('Xvnc exited (%s): the desktop is gone' % server_process.returncode)
                return 1
            time.sleep(0.2)
        return 0
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        stop(program)
        stop(server_process)


if __name__ == '__main__':
    sys.exit(main())
