#!/usr/bin/python3 -I
# The browser tool's driver (piki:browser; see apps/runner/src/browser-command.ts and docs/design/piki-extensions.md),
# embedded in the connector through sandbox-python.generated.ts (`pnpm python:embed` writes it; tests/sandbox-python.test.ts
# checks it is current).
#
# It runs only in the session's Linux sandbox, never on the host itself. One call is one sandboxed command: it starts the
# host's Chromium (which the sandbox gives commands read-only) headless with a profile in the session's home, drives
# it over the DevTools protocol on a pipe (--remote-debugging-pipe, so it opens no port), opens the request's page, runs
# its actions, and leaves a screenshot and a JSON report of the page in the worktree's browser-output directory, which
# the session panel's Browser tab shows. It prints that report as the call's output. `serve`, the web app under test,
# runs beside it for the call only, as a command's processes and network end with it: one of the node or python tools'
# programs, started without a shell, with that tool's environment.
#
# Only the standard library: it runs with the sandbox's /usr/bin/python3, 3.9 or newer.
import base64
import fcntl
import json
import os
import re
import select
import signal
import socket
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

# Where the report and screenshots go, relative to the worktree, and how many calls' files are kept there. The runner
# reads the screenshot back from it (browser-command.ts BROWSER_OUTPUT and BROWSER_KEPT, tests/sandbox-python.test.ts
# checks them).
OUTPUT = 'browser-output'
KEPT = 30
# Bounds of what the report holds, so the call's output stays well within a command's.
MAX_TEXT = 6000
MAX_ELEMENTS = 80
MAX_CONSOLE = 40
MAX_ENTRY = 500
MAX_VALUE = 4000
MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
DEFAULT_VIEWPORT = (1280, 800)
# The node and python tools' programs, and what they run with: node-command.ts nodePrograms and NODE_ENVIRONMENT,
# python-command.ts pythonPrograms and PYTHON_ENVIRONMENT (tests/sandbox-python.test.ts checks them).
NODE_PROGRAMS = ('node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack')
NODE_ENVIRONMENT = 'NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true'
PYTHON_PROGRAMS = ('python3', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pytest')
PYTHON_ENVIRONMENT = 'NO_COLOR=1 PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 POETRY_NO_INTERACTION=1 UV_NO_PROGRESS=1'
# Chromium's flags: headless, no sandbox of its own (the session's sandbox has no user namespaces to give it, and is the
# boundary), no shared memory (the sandbox's /dev/shm is read-only), and none of the background traffic a fresh profile
# makes, which the session's proxy would only refuse.
CHROME_FLAGS = [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-pipe',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-domain-reliability', '--metrics-recording-only', '--no-pings', '--mute-audio', '--hide-scrollbars',
    '--password-store=basic', '--use-mock-keychain', '--disk-cache-size=1', '--font-render-hinting=none',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
]
KEYS = {
    'Enter': (13, 'Enter', '\r'), 'Tab': (9, 'Tab', ''), 'Escape': (27, 'Escape', ''), 'Backspace': (8, 'Backspace', ''),
    'Delete': (46, 'Delete', ''), 'Space': (32, 'Space', ' '), 'ArrowUp': (38, 'ArrowUp', ''), 'ArrowDown': (40, 'ArrowDown', ''),
    'ArrowLeft': (37, 'ArrowLeft', ''), 'ArrowRight': (39, 'ArrowRight', ''), 'Home': (36, 'Home', ''), 'End': (35, 'End', ''),
    'PageUp': (33, 'PageUp', ''), 'PageDown': (34, 'PageDown', ''),
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
# The host's fontconfig rules worth having where the sandbox has no /etc/fonts: the generic families and their aliases.
FONT_RULES = ('30-metric-aliases.conf', '40-nonlatin.conf', '45-generic.conf', '45-latin.conf', '49-sansserif.conf',
              '60-generic.conf', '60-latin.conf', '65-nonlatin.conf')


class BrowserError(Exception):
    pass


OUT_OF_TIME = "the call ran out of time: the host's command time limit is almost up"


# The page's side of the driver: finding elements, describing the page. Run with Runtime.evaluate.
PAGE_SCRIPT = r'''
(() => {
  if (window.__pikibun) return;
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const squash = text => (text || '').replace(/\s+/g, ' ').trim();
  const label = el => squash(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder')
    || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '');
  const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const cssPath = el => {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const attribute of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const value = el.getAttribute(attribute);
      if (value) {
        const selector = el.localName + '[' + attribute + '="' + CSS.escape(value) + '"]';
        if (unique(selector)) return selector;
      }
    }
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node !== el && node.id && unique('#' + CSS.escape(node.id))) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
      parts.unshift(siblings.length > 1 ? node.localName + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : node.localName);
    }
    return parts.join(' > ');
  };
  const interactive = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], '
    + '[role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [contenteditable=""], '
    + '[contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const find = selector => {
    if (selector.startsWith('text=')) {
      const wanted = squash(selector.slice(5)).toLowerCase();
      if (!wanted) return null;
      const candidates = [...document.querySelectorAll(interactive + ', label, h1, h2, h3, h4, li, td, th, p, span, div')].filter(visible);
      const exact = candidates.filter(el => label(el).toLowerCase() === wanted);
      const partial = exact.length ? exact : candidates.filter(el => label(el).toLowerCase().includes(wanted));
      if (!partial.length) return null;
      // Interactive elements first, then the innermost: a button rather than the div around it.
      partial.sort((a, b) => Number(!a.matches(interactive)) - Number(!b.matches(interactive)) || label(a).length - label(b).length);
      return partial[0];
    }
    return document.querySelector(selector);
  };
  window.__pikibun = {
    find,
    point(selector) {
      const el = find(selector);
      if (!el) return { error: 'no element matches ' + selector };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { error: selector + ' is not visible' };
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? cssPath(top) : null;
      return { x, y, covered };
    },
    focus(selector, clear) {
      const el = find(selector);
      if (!el) return { error: 'no element matches ' + selector };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus();
      if (document.activeElement !== el && !el.contains(document.activeElement)) return { error: selector + ' cannot take focus' };
      if (clear) {
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) document.execCommand('selectAll');
      }
      return {};
    },
    select(selector, value) {
      const el = find(selector);
      if (!el) return { error: 'no element matches ' + selector };
      if (el.localName !== 'select') return { error: selector + ' is not a select element' };
      const option = [...el.options].find(item => item.value === value) || [...el.options].find(item => squash(item.text) === squash(value));
      if (!option) return { error: 'no option ' + JSON.stringify(value) + ' in ' + selector };
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {};
    },
    present(selector) { const el = find(selector); return !!el && visible(el); },
    describe(maxText, maxElements) {
      const raw = document.body ? document.body.innerText || '' : '';
      const text = raw.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      const elements = [];
      for (const el of document.querySelectorAll(interactive)) {
        if (!visible(el)) continue;
        if (elements.length >= maxElements) break;
        const item = { selector: cssPath(el), tag: el.localName };
        const type = el.getAttribute('type') || el.getAttribute('role');
        if (type) item.type = type;
        const name = label(el).slice(0, 80);
        if (name) item.text = name;
        if (el.localName === 'a' && el.href) item.href = el.href.slice(0, 200);
        if (el.disabled) item.disabled = true;
        if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
        elements.push(item);
      }
      return { text: text.slice(0, maxText), textTruncated: text.length > maxText, elements,
        size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
    },
  };
})()
'''


def bounded(text: Any, limit: int = MAX_ENTRY) -> str:
    value = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    return value if len(value) <= limit else value[:limit - 1] + '\u2026'


def high_fd(fd: int) -> int:
    # Out of the way of 3 and 4, which Chromium's end of the pipes takes.
    moved = fcntl.fcntl(fd, fcntl.F_DUPFD, 10)
    os.close(fd)
    return moved


def fonts_config() -> Optional[str]:
    # The sandbox has no /etc: give Chromium's fontconfig the host's fonts and family rules, cached in the session's home.
    if os.path.exists('/etc/fonts/fonts.conf'):
        return None
    temporary = os.environ.get('TMPDIR') or os.path.join(os.environ.get('HOME', '.'), '.tmp')
    cache = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.join(os.environ.get('HOME', '.'), '.cache'), 'fontconfig')
    rules = [os.path.join('/usr/share/fontconfig/conf.avail', name) for name in FONT_RULES]
    includes = '\n'.join('  <include ignore_missing="yes">' + path + '</include>' for path in rules if os.path.exists(path))
    os.makedirs(temporary, exist_ok=True)
    path = os.path.join(temporary, 'pikibun-browser-fonts.conf')
    with open(path, 'w') as handle:
        handle.write(FONTS_CONF.format(cache=cache, includes=includes))
    return path


class Chrome:
    """Chromium on a DevTools pipe: commands go to its fd 3, answers and events come from its fd 4."""

    def __init__(self, executable: str, profile: str, viewport: Tuple[int, int], log: str, deadline: float):
        self.deadline = deadline
        self.started = time.monotonic()
        # Whether Chromium has said anything on the pipe yet: one that never does is stuck starting, and says why in its log.
        self.answered = False
        self.next_id = 0
        self.buffer = b''
        self.events: List[Dict[str, Any]] = []
        self.handlers: List[Callable[[Dict[str, Any]], None]] = []
        commands_read, commands_write = (high_fd(fd) for fd in os.pipe())
        answers_read, answers_write = (high_fd(fd) for fd in os.pipe())
        for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
            # A call killed at its time limit leaves these; no other Chromium uses this session's profile.
            try:
                os.unlink(os.path.join(profile, name))
            except OSError:
                pass
        env = dict(os.environ)
        # No D-Bus: headless Chromium needs none, and where it can reach the machine's bus (the driver run outside a
        # session's sandbox, which has none), a call there that stalls holds its start for D-Bus's 25-second timeout.
        env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/nonexistent/pikibun-no-bus'
        env['DBUS_SYSTEM_BUS_ADDRESS'] = 'unix:path=/nonexistent/pikibun-no-bus'
        fonts = fonts_config()
        if fonts:
            env['FONTCONFIG_FILE'] = fonts
        # Chromium binds its profile's singleton socket in TMPDIR, and a Unix socket's path holds at most 107 bytes: the
        # session's own (/sessions/<64 hex digits>/home/.tmp) leaves too few, and Chrome and Chromium (but not the headless
        # shell) crash at start. So Chromium runs in a directory of its own there, which TMPDIR names by a short path.
        work = os.path.join(env.get('TMPDIR') or os.path.join(env.get('HOME', '.'), '.tmp'), 'pikibun-browser')
        os.makedirs(work, exist_ok=True)
        if os.path.isdir('/proc/self/cwd'):
            env['TMPDIR'] = '/proc/self/cwd'
        proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
        flags = list(CHROME_FLAGS) + ['--user-data-dir=' + profile, '--window-size=%d,%d' % viewport]
        if proxy:
            # Loopback (a `serve` command's port) stays direct, as Chromium bypasses the proxy for it by default.
            flags.append('--proxy-server=' + proxy)

        def child() -> None:
            os.dup2(commands_read, 3)
            os.dup2(answers_write, 4)

        self.log = open(log, 'wb')
        try:
            self.process = subprocess.Popen([executable] + flags + ['about:blank'], stdin=subprocess.DEVNULL, stdout=self.log,
                                            stderr=self.log, env=env, cwd=work, preexec_fn=child, pass_fds=(3, 4), start_new_session=True)
        except OSError as error:
            raise BrowserError('cannot start ' + executable + ': ' + (error.strerror or str(error))) from error
        finally:
            os.close(commands_read)
            os.close(answers_write)
        self.writer = commands_write
        self.reader = answers_read

    def remaining(self, timeout: float) -> float:
        return max(0.0, min(timeout, self.deadline - time.monotonic()))

    def pump(self, timeout: float) -> bool:
        """Reads what Chromium sent within `timeout`, dispatching events; false once the pipe is closed."""
        ready, _, _ = select.select([self.reader], [], [], max(0.0, timeout))
        if not ready:
            return True
        chunk = os.read(self.reader, 1 << 20)
        if not chunk:
            return False
        self.answered = True
        self.buffer += chunk
        while b'\0' in self.buffer:
            raw, self.buffer = self.buffer.split(b'\0', 1)
            message = json.loads(raw.decode('utf-8', 'replace'))
            if 'id' in message:
                self.events.append(message)
            else:
                for handler in self.handlers:
                    handler(message)
        return True

    def send(self, method: str, params: Optional[Dict[str, Any]] = None, session: Optional[str] = None, timeout: float = 30) -> Dict[str, Any]:
        self.next_id += 1
        ident = self.next_id
        message: Dict[str, Any] = {'id': ident, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        data = json.dumps(message).encode() + b'\0'
        while data:
            written = os.write(self.writer, data)
            data = data[written:]
        if self.remaining(timeout) <= 0:
            raise BrowserError(OUT_OF_TIME)
        until = time.monotonic() + self.remaining(timeout)
        while True:
            for index, answer in enumerate(self.events):
                if answer.get('id') == ident:
                    del self.events[index]
                    if 'error' in answer:
                        raise BrowserError(method + ': ' + str(answer['error'].get('message', answer['error'])))
                    return answer.get('result', {})
            left = until - time.monotonic()
            if left <= 0:
                if not self.answered:
                    raise BrowserError('Chromium did not answer within %d seconds of starting: %s' % (round(time.monotonic() - self.started), self.tail()))
                raise BrowserError(OUT_OF_TIME if time.monotonic() >= self.deadline else method + ' took too long')
            if not self.pump(left):
                raise BrowserError('the browser closed: ' + self.tail())

    def tail(self) -> str:
        try:
            self.log.flush()
            with open(self.log.name, 'rb') as handle:
                handle.seek(0, os.SEEK_END)
                handle.seek(max(0, handle.tell() - 1500))
                return bounded(handle.read().decode('utf-8', 'replace').strip(), 1500) or 'no output'
        except OSError:
            return 'no output'

    def close(self) -> None:
        try:
            self.send('Browser.close', timeout=3)
        except (BrowserError, OSError):
            pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            stop_group(self.process)
        for fd in (self.reader, self.writer):
            try:
                os.close(fd)
            except OSError:
                pass
        self.log.close()


def stop_group(process: 'subprocess.Popen[bytes]') -> None:
    for sent in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sent)
        except OSError:
            return
        try:
            process.wait(timeout=2)
            return
        except subprocess.TimeoutExpired:
            continue


class Page:
    """One tab, attached in flat mode, with what it logged and loaded."""

    def __init__(self, chrome: Chrome, viewport: Tuple[int, int]):
        self.chrome = chrome
        self.console: List[Dict[str, Any]] = []
        self.errors: List[str] = []
        self.failed: List[Dict[str, Any]] = []
        self.requests: Dict[str, str] = {}
        self.inflight: Dict[str, float] = {}
        self.loading = False
        self.navigated = 0
        self.status: Optional[int] = None
        self.frame = ''
        self.session = ''
        chrome.handlers.append(self.event)
        targets = chrome.send('Target.getTargets')['targetInfos']
        page = next((target for target in targets if target.get('type') == 'page'), None)
        target = page['targetId'] if page else chrome.send('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.session = chrome.send('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        for method in ('Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'):
            self.send(method)
        # What the page's server serves now, never what an earlier call kept: the app under test changes between calls.
        self.send('Network.setCacheDisabled', {'cacheDisabled': True})
        self.send('Page.setLifecycleEventsEnabled', {'enabled': True})
        self.frame = self.send('Page.getFrameTree')['frameTree']['frame']['id']
        self.send('Emulation.setDeviceMetricsOverride', {'width': viewport[0], 'height': viewport[1], 'deviceScaleFactor': 1, 'mobile': False})

    def send(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 30) -> Dict[str, Any]:
        return self.chrome.send(method, params, self.session, timeout)

    def note(self, target: List[Any], value: Any, limit: int) -> None:
        target.append(value)
        if len(target) > limit:
            del target[0]

    def event(self, message: Dict[str, Any]) -> None:
        if message.get('sessionId') != self.session:
            return
        method = message.get('method')
        params = message.get('params', {})
        if method == 'Runtime.consoleAPICalled':
            parts = [str(arg['value']) if 'value' in arg else arg.get('description', arg.get('type', '')) for arg in params.get('args', [])]
            self.note(self.console, {'level': params.get('type', 'log'), 'text': bounded(' '.join(parts))}, MAX_CONSOLE)
        elif method == 'Runtime.exceptionThrown':
            details = params.get('exceptionDetails', {})
            exception = details.get('exception') or {}
            self.note(self.errors, bounded(exception.get('description') or details.get('text', 'Uncaught exception')), 20)
        elif method == 'Log.entryAdded':
            entry = params.get('entry', {})
            if entry.get('level') in ('error', 'warning'):
                text = entry.get('text', '') + (' (' + entry['url'] + ')' if entry.get('url') else '')
                self.note(self.console, {'level': entry['level'], 'text': bounded(text), 'source': entry.get('source', '')}, MAX_CONSOLE)
        elif method == 'Network.requestWillBeSent':
            self.requests[params['requestId']] = params['request']['url']
            self.inflight[params['requestId']] = time.monotonic()
        elif method in ('Network.loadingFinished', 'Network.loadingFailed'):
            self.inflight.pop(params.get('requestId', ''), None)
            if method == 'Network.loadingFailed' and not params.get('canceled'):
                url = self.requests.get(params.get('requestId', ''), '')
                self.note(self.failed, {'url': bounded(url, 300), 'error': params.get('errorText', '')}, 20)
        elif method == 'Network.responseReceived':
            response = params.get('response', {})
            if params.get('type') == 'Document' and params.get('frameId') == self.frame:
                self.status = response.get('status')
            if response.get('status', 0) >= 400:
                self.note(self.failed, {'url': bounded(response.get('url', ''), 300), 'status': response.get('status')}, 20)
        elif method == 'Page.frameStartedLoading' and params.get('frameId') == self.frame:
            self.loading = True
            self.navigated += 1
        elif method in ('Page.frameStoppedLoading', 'Page.loadEventFired') and params.get('frameId', self.frame) == self.frame:
            self.loading = False

    def settle(self, timeout: float, quiet: float = 0.5, longest: float = 3.0) -> None:
        """Waits for the main frame to load, then up to `longest` for the network to be quiet for `quiet` seconds."""
        until = time.monotonic() + self.chrome.remaining(timeout)
        while self.loading and time.monotonic() < until:
            self.chrome.pump(min(0.1, until - time.monotonic()))
        if self.loading:
            raise BrowserError('the page took over %d seconds to load' % timeout)
        settled = time.monotonic() + self.chrome.remaining(longest)
        calm_since = time.monotonic()
        while time.monotonic() < settled:
            now = time.monotonic()
            # Requests open for long (a stream, a long poll) don't hold it up.
            busy = [started for started in self.inflight.values() if now - started < 5]
            if busy:
                calm_since = now
            elif now - calm_since >= quiet:
                return
            self.chrome.pump(0.05)

    def evaluate(self, expression: str, timeout: float = 30) -> Any:
        result = self.send('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True, 'userGesture': True}, timeout)
        if 'exceptionDetails' in result:
            details = result['exceptionDetails']
            raise BrowserError(bounded((details.get('exception') or {}).get('description') or details.get('text', 'the script threw')))
        return result.get('result', {}).get('value')

    def helper(self, call: str, timeout: float = 30) -> Any:
        return self.evaluate(PAGE_SCRIPT + ';window.__pikibun.' + call, timeout)

    def navigate(self, url: str, timeout: float) -> None:
        self.status = None
        answer = self.send('Page.navigate', {'url': url}, timeout)
        if answer.get('errorText'):
            raise BrowserError('cannot open ' + url + ': ' + answer['errorText'] + proxy_hint(answer['errorText']))
        self.loading = bool(answer.get('loaderId'))
        self.settle(timeout)

    def after_input(self, timeout: float) -> None:
        # A click or a key may start a navigation, which shows within a moment, or only change the page.
        before = self.navigated
        until = time.monotonic() + self.chrome.remaining(0.3)
        while time.monotonic() < until:
            self.chrome.pump(0.05)
        self.settle(timeout if self.navigated != before or self.loading else 0, longest=2.0)

    def mouse(self, kind: str, x: float, y: float, clicks: int = 0) -> None:
        params: Dict[str, Any] = {'type': kind, 'x': x, 'y': y}
        if kind != 'mouseMoved':
            params.update({'button': 'left', 'clickCount': clicks})
        self.send('Input.dispatchMouseEvent', params)

    def key(self, name: str) -> None:
        if name in KEYS:
            code, key, text = KEYS[name]
        elif len(name) == 1:
            code, key, text = ord(name.upper()), name, name
        else:
            raise BrowserError('unknown key ' + name + ': use one of ' + ', '.join(KEYS) + ', or a single character')
        common = {'key': key, 'code': key if len(key) > 1 else 'Key' + key.upper(), 'windowsVirtualKeyCode': code, 'nativeVirtualKeyCode': code}
        self.send('Input.dispatchKeyEvent', dict(common, type='keyDown' if text else 'rawKeyDown', **({'text': text} if text else {})))
        self.send('Input.dispatchKeyEvent', dict(common, type='keyUp'))

    def screenshot(self, path: str, full_page: bool) -> Dict[str, Any]:
        params: Dict[str, Any] = {'format': 'png'}
        if full_page:
            metrics = self.send('Page.getLayoutMetrics')
            size = metrics.get('cssContentSize') or metrics.get('contentSize') or {}
            width, height = size.get('width', 0), size.get('height', 0)
            # A page longer than this is cut: its picture would only be scaled down past reading.
            if width and height:
                params.update({'captureBeyondViewport': True, 'clip': {'x': 0, 'y': 0, 'width': width, 'height': min(height, 8000), 'scale': 1}})
        data = base64.b64decode(self.send('Page.captureScreenshot', params)['data'])
        if len(data) > MAX_SCREENSHOT_BYTES:
            params.update({'format': 'jpeg', 'quality': 80})
            data = base64.b64decode(self.send('Page.captureScreenshot', params)['data'])
            path = re.sub(r'\.png$', '.jpg', path)
        with open(path, 'wb') as handle:
            handle.write(data)
        return {'screenshot': path}


def proxy_hint(error: str) -> str:
    if error in ('net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'):
        return (" (the session's network goes through its proxy, which refuses hosts the workspace's network access doesn't allow, "
                'and plain http:// outside the sandbox)')
    if error == 'net::ERR_CONNECTION_REFUSED':
        return ' (nothing listens there: a local server runs only within the same call, started with serve)'
    return ''


def act(page: Page, action: Dict[str, Any], index: int, stamp: str, timeout: float) -> Dict[str, Any]:
    kind = action['action']
    selector = action.get('selector')
    if kind in ('goto', 'back', 'forward', 'reload'):
        if kind == 'goto':
            page.navigate(action['url'], timeout)
        else:
            history = page.send('Page.getNavigationHistory')
            if kind == 'reload':
                page.send('Page.reload')
            else:
                step = -1 if kind == 'back' else 1
                at = history['currentIndex'] + step
                if not 0 <= at < len(history['entries']):
                    raise BrowserError('no page to go ' + kind + ' to')
                page.send('Page.navigateToHistoryEntry', {'entryId': history['entries'][at]['id']})
            page.after_input(timeout)
        return {}
    if kind in ('click', 'hover'):
        if selector:
            point = page.helper('point(%s)' % json.dumps(selector))
            if point.get('error'):
                raise BrowserError(point['error'])
            x, y = point['x'], point['y']
        else:
            x, y = action['x'], action['y']
            point = {}
        page.mouse('mouseMoved', x, y)
        if kind == 'click':
            page.mouse('mousePressed', x, y, 1)
            page.mouse('mouseReleased', x, y, 1)
            page.after_input(timeout)
        result: Dict[str, Any] = {}
        if point.get('covered'):
            result['note'] = 'another element covered its centre: ' + point['covered']
        return result
    if kind == 'type':
        if selector:
            focused = page.helper('focus(%s, %s)' % (json.dumps(selector), 'false' if action.get('clear') is False else 'true'))
            if focused.get('error'):
                raise BrowserError(focused['error'])
        page.send('Input.insertText', {'text': action['text']})
        if action.get('submit'):
            page.key('Enter')
        page.after_input(timeout)
        return {}
    if kind == 'press':
        page.key(action['key'])
        page.after_input(timeout)
        return {}
    if kind == 'select':
        selected = page.helper('select(%s, %s)' % (json.dumps(selector), json.dumps(action['value'])))
        if selected.get('error'):
            raise BrowserError(selected['error'])
        page.after_input(timeout)
        return {}
    if kind == 'scroll':
        if selector:
            point = page.helper('point(%s)' % json.dumps(selector))
            if point.get('error'):
                raise BrowserError(point['error'])
        else:
            page.evaluate('window.scrollBy(%d, %d)' % (int(action.get('x', 0)), int(action.get('y', 0))))
        page.after_input(timeout)
        return {}
    if kind == 'wait':
        began = time.monotonic()
        until = began + page.chrome.remaining(timeout)
        if selector or action.get('text') is not None:
            check = 'present(%s)' % json.dumps(selector) if selector else None
            wanted = str(action.get('text', ''))
            while True:
                if time.monotonic() >= until:
                    limited = ' before the call ran out of time' if until < began + timeout else ''
                    raise BrowserError('waited %d seconds for %s%s' % (round(time.monotonic() - began), selector or json.dumps(wanted), limited))
                left = until - time.monotonic()
                found = page.helper(check, left) if check else wanted in str(page.evaluate('document.body ? document.body.innerText : ""', left) or '')
                if found:
                    return {}
                page.chrome.pump(min(0.2, max(0.0, until - time.monotonic())))
        pause = time.monotonic() + page.chrome.remaining(action.get('ms', 1000) / 1000)
        while time.monotonic() < pause:
            page.chrome.pump(pause - time.monotonic())
        return {}
    if kind == 'evaluate':
        value = page.evaluate(action['expression'], timeout)
        return {'value': bounded(value, MAX_VALUE)}
    if kind == 'screenshot':
        return page.screenshot(os.path.join(OUTPUT, '%s-%d.png' % (stamp, index + 1)), bool(action.get('full_page')))
    raise BrowserError('unknown action ' + kind)


def port_open(port: int) -> bool:
    for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                if probe.connect_ex((address, port)) == 0:
                    return True
        except OSError:
            continue
    return False


def log_tail(path: str, limit: int = 3000) -> str:
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - limit))
            return handle.read().decode('utf-8', 'replace').strip()
    except OSError:
        return ''


def serve_launch(spec: Dict[str, Any], node_bin: Optional[str]) -> Tuple[List[str], str, Dict[str, str]]:
    """What starts `serve`'s program, as its own tool would run it: its arguments, where, and with what environment."""
    program = spec['program']
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
        raise BrowserError('serve runs one of ' + ', '.join(NODE_PROGRAMS + PYTHON_PROGRAMS) + ', not ' + program)
    for item in fixed.split():
        name, value = item.split('=', 1)
        env[name] = value
    env['PATH'] = ':'.join(first + [os.environ.get('PATH') or '/usr/bin:/bin', '/usr/local/bin'])
    return [program] + [str(arg) for arg in spec.get('args') or []], directory, env


def serve(spec: Dict[str, Any], node_bin: Optional[str], log: str, deadline: float) -> 'subprocess.Popen[bytes]':
    """Starts the web app under test, in a process group of its own to stop when the call ends, and waits for its port."""
    args, directory, env = serve_launch(spec, node_bin)
    with open(log, 'wb') as output:
        try:
            process = subprocess.Popen(args, cwd=directory, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        except OSError as error:
            raise BrowserError('serve could not start %s: %s' % (args[0], error.strerror or error)) from error
    wait = spec.get('timeout_seconds', 60)
    until = min(time.monotonic() + wait, deadline)
    while not port_open(spec['port']):
        if process.poll() is not None:
            raise BrowserError('serve exited (%s) before port %d answered:\n%s' % (process.returncode, spec['port'], bounded(log_tail(log), 3000)))
        if time.monotonic() >= until:
            stop_group(process)
            raise BrowserError('port %d did not answer within %d seconds of serve starting:\n%s' % (spec['port'], wait, bounded(log_tail(log), 3000)))
        time.sleep(0.2)
    return process


def prune() -> None:
    # Keeps the newest KEPT calls: a report and the screenshots named after it.
    try:
        names = sorted(os.listdir(OUTPUT))
    except OSError:
        return
    reports = [name[:-5] for name in names if re.match(r'^\d{8}-\d{6}-\d{3}\.json$', name)]
    for stamp in reports[:-KEPT]:
        for name in names:
            if name.startswith(stamp):
                try:
                    os.unlink(os.path.join(OUTPUT, name))
                except OSError:
                    pass


def last_url() -> Optional[str]:
    try:
        names = sorted(name for name in os.listdir(OUTPUT) if re.match(r'^\d{8}-\d{6}-\d{3}\.json$', name))
        with open(os.path.join(OUTPUT, names[-1])) as handle:
            url = json.load(handle).get('url')
        return url if isinstance(url, str) and url and url != 'about:blank' else None
    except (OSError, IndexError, ValueError, AttributeError):
        return None


def main() -> int:
    args = sys.argv[1:]
    executable = None
    node_bin = None
    seconds = 30
    while len(args) > 1 and args[0] in ('--chrome', '--time-limit', '--node-bin'):
        if args[0] == '--chrome':
            executable = args[1]
        elif args[0] == '--node-bin':
            node_bin = args[1]
        else:
            seconds = int(args[1])
        args = args[2:]
    if len(args) != 1 or not executable:
        print(json.dumps({'error': "usage: pikibun-browser --chrome <chromium> [--time-limit <seconds>] [--node-bin <directory>] '<request as JSON>'"}))
        return 2
    started = time.monotonic()
    # Actions stop a few seconds before the command's own limit, which leaves the report (with a screenshot) time to be
    # made; the report itself may take until a second before it.
    deadline = started + max(5, seconds - 5)
    final = started + max(6, seconds - 1)
    request = json.loads(args[0])
    viewport = request.get('viewport') or {}
    size = (int(viewport.get('width', DEFAULT_VIEWPORT[0])), int(viewport.get('height', DEFAULT_VIEWPORT[1])))
    timeout = float(request.get('timeout_seconds', 30))
    os.makedirs(OUTPUT, exist_ok=True)
    now = time.time()
    stamp = time.strftime('%Y%m%d-%H%M%S', time.gmtime(now)) + '-%03d' % int(now % 1 * 1000)
    home = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.environ.get('HOME', '.'), '.cache')
    profile = os.path.join(home, 'pikibun-browser', 'profile')
    os.makedirs(profile, exist_ok=True)
    temporary = os.environ.get('TMPDIR') or os.path.join(os.environ.get('HOME', '.'), '.tmp')
    os.makedirs(temporary, exist_ok=True)
    url = request.get('url') or last_url()
    report: Dict[str, Any] = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)), 'request': request}
    if url and not request.get('url'):
        report['reopened'] = url
    server = None
    chrome = None
    page = None
    try:
        if request.get('serve'):
            server = serve(request['serve'], node_bin, os.path.join(temporary, 'pikibun-browser-serve.log'), deadline)
        chrome = Chrome(executable, profile, size, os.path.join(temporary, 'pikibun-browser-chrome.log'), deadline)
        page = Page(chrome, size)
        if url:
            page.navigate(url, timeout)
        steps: List[Dict[str, Any]] = []
        report['actions'] = steps
        for index, action in enumerate(request.get('actions') or []):
            try:
                outcome = act(page, action, index, stamp, timeout)
                steps.append(dict({'action': action['action'], 'ok': True}, **outcome))
            except BrowserError as error:
                steps.append({'action': action['action'], 'ok': False, 'error': str(error)})
                report['error'] = 'action %d (%s) failed: %s' % (index + 1, action['action'], error)
                skipped = len(request['actions']) - index - 1
                if skipped:
                    report['skipped'] = skipped
                break
    except BrowserError as error:
        report['error'] = str(error)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # The browser answered something unexpected, or went away: the report still says what it got to.
        report['error'] = 'the browser failed: %s: %s' % (type(error).__name__, bounded(str(error)))
    if chrome is not None:
        chrome.deadline = final
    if page is not None:
        try:
            report['url'] = page.evaluate('location.href', 5)
            report['title'] = page.evaluate('document.title', 5)
            if page.status is not None:
                report['status'] = page.status
            described = page.helper('describe(%d, %d)' % (MAX_TEXT, MAX_ELEMENTS), 5)
            report['text'] = described['text']
            if described['textTruncated']:
                report['text_truncated'] = True
            report['elements'] = described['elements']
            report['page_size'] = described['size']
        except BrowserError as error:
            report.setdefault('error', str(error))
        try:
            report['screenshot'] = page.screenshot(os.path.join(OUTPUT, stamp + '.png'), bool(request.get('full_page')))['screenshot']
        except BrowserError as error:
            report.setdefault('error', 'no screenshot: ' + str(error))
        if page.console:
            report['console'] = page.console
        if page.errors:
            report['page_errors'] = page.errors
        if page.failed:
            report['failed_requests'] = page.failed
    if chrome is not None:
        chrome.close()
    if server is not None:
        stop_group(server)
        output = log_tail(os.path.join(temporary, 'pikibun-browser-serve.log'), 2000)
        if output:
            report['serve_output'] = output
    report['seconds'] = round(time.monotonic() - started, 1)
    with open(os.path.join(OUTPUT, stamp + '.json'), 'w') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    prune()
    report.pop('request', None)
    report['report'] = os.path.join(OUTPUT, stamp + '.json')
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0 if page is not None else 1


if __name__ == '__main__':
    sys.exit(main())
