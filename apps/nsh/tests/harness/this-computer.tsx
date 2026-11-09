import { host as embedder, mount, signal, Text, View } from "nsh";
import type { HostInspection, LoginProvider } from "../../../runner/src/desktop-protocol";
import { setHostLauncher, thisComputer, type HostLink } from "../../src/lib/this-computer";
import { ThisComputerPanel } from "../../src/settings/ThisComputer";

// Settings › This Mac against a stand-in for `pikibun host --stdio`: it answers the desktop host's protocol as the real
// one does, for a Mac without a sandbox. `host.params`: `command`, how the command fares ("ok", "missing": not
// installed, "outdated": a CLI without `host`); `paired`, the server it is paired with; `piSignedIn` (true), whether Pi
// has a provider yet; `server`, the one the page is signed in to. What the app sent is listed under the panel, secrets
// left out, for the tests to read.

const params = embedder.params as { command?: unknown; paired?: unknown; piSignedIn?: unknown; server?: unknown };
const SERVER = typeof params.server === "string" ? params.server : "https://pikibun.test";
const command = String(params.command ?? "ok");
const sent = signal<string[]>([]);
let paired: string | undefined = typeof params.paired === "string" ? params.paired : undefined;
let signedIn = params.piSignedIn !== false;
/** As the real host: a pairing with plain HTTP reads only where loopback is allowed (connector.ts, controlPlaneOrigin). */
const loopback = (origin: string) => origin.startsWith("http://");

const model = { provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet" };
const inspection = (allowLoopback: boolean): HostInspection => ({
  platform: "darwin", stateDir: "/Users/ada/.local/share/pikibun/connector", mode: "unsandboxed",
  unsandboxedWarning: "WARNING: --unsafe-no-sandbox runs agent work directly on this machine.",
  prerequisites: [
    { name: "Git", ok: true },
    { name: "npm", ok: false, optional: true, fix: { text: "Install Node.js and npm to add extensions.", command: "brew install node", url: "https://nodejs.org" } },
  ],
  models: signedIn ? [model, { provider: "anthropic", modelId: "claude-opus", name: "Claude Opus" }] : [],
  ...(signedIn ? {} : { modelsError: "Pi has no models with configured authentication." }),
  ...(paired && (!loopback(paired) || allowLoopback) ? { pairedServer: paired } : {}),
  ...(paired && loopback(paired) && !allowLoopback ? { pairingError: "This computer's saved pairing could not be read." } : {}),
});
const providers = (): LoginProvider[] => [{ id: "anthropic", name: "Anthropic", signedIn, methods: [{ type: "api_key", name: "Anthropic API key" }] }];

/** One stand-in host process. */
function fakeHost(): HostLink {
  const messages: ((value: unknown) => void)[] = [];
  const output: ((line: string) => void)[] = [];
  const exits: ((result: { code?: number | null }) => void)[] = [];
  let ended = false;
  const emit = (value: unknown) => setTimeout(() => { if (!ended) for (const listener of messages) listener(value); }, 1);
  const exit = (code: number) => setTimeout(() => { ended = true; for (const listener of exits) listener({ code }); }, 1);
  let login: number | undefined;
  setTimeout(() => {
    if (command === "missing") { for (const listener of output) listener("zsh:1: command not found: pikibun"); exit(127); return; }
    if (command === "outdated") { for (const listener of output) listener("Unknown command: host"); exit(2); return; }
    emit({ type: "ready" });
  }, 1);
  return {
    send: message => {
      const request = message as { type: string; id: number; [key: string]: unknown };
      const { id: _id, ...shown } = request;
      // Secrets are never shown, only that there were some: the pairing code, an answer (an API key).
      if (shown.pairing) shown.pairing = { id: (shown.pairing as { id: string }).id, code: "<code>" };
      if (typeof shown.value === "string") shown.value = `<${shown.value.length} characters>`;
      sent.update(list => [...list, JSON.stringify(shown)]);
      const reply = (extra: object = {}) => emit({ type: "result", id: request.id, ok: true, ...extra });
      if (request.type === "inspect") reply({ inspection: inspection(request.allowInsecureLoopback === true) });
      else if (request.type === "providers") reply({ providers: providers() });
      else if (request.type === "start") {
        if (request.pairing) paired = String(request.server);
        emit({ type: "status", state: "starting", server: request.server, unsandboxed: true });
        reply();
        emit({ type: "status", state: "connected", server: request.server, unsandboxed: true, connectorId: "c9" });
        emit({ type: "log", level: "info", message: `Connected to ${String(request.server)}.` });
      } else if (request.type === "stop") {
        emit({ type: "status", state: "stopping" });
        emit({ type: "status", state: "stopped" });
        reply();
      } else if (request.type === "login") {
        login = request.id;
        emit({ type: "login", login, event: { kind: "prompt", prompt: 1, detail: { type: "secret", message: "Anthropic API key", placeholder: "sk-ant-…" } } });
      } else if (request.type === "login-answer") {
        signedIn = true;
        reply();
        if (login !== undefined) emit({ type: "result", id: login, ok: true });
      } else reply();
    },
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onExit: listener => { exits.push(listener); },
    end: () => exit(0),
    kill: () => exit(1),
  };
}

setHostLauncher(fakeHost);
const host = thisComputer();
mount(() => (
  <View style={{ flex: 1 }}>
    <ThisComputerPanel host={host} server={SERVER} createPairing={async name => {
      sent.update(list => [...list, `pairing ${name}`]);
      return { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", code: "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw" };
    }} />
    <View testID="fake-host-sent">
      <Each of={sent()} key="index">{line => <Text>{`sent ${line()}`}</Text>}</Each>
    </View>
  </View>
));
