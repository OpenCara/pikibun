import { host as embedder, mount, signal, Text, View } from "nsh";
import type { HostInspection, LoginProvider } from "../../../runner/src/app-host-protocol";
import { appCliFolder, installCommand, setHostLauncher, setInstaller, thisComputer, type HostLink, type InstallRun } from "../../src/lib/this-computer";
import { Button } from "../../src/ui";
import { ThisComputerPanel } from "../../src/settings/ThisComputer";

const params = embedder.params as { command?: unknown; paired?: unknown; piSignedIn?: unknown; server?: unknown; npm?: unknown };
const SERVER = typeof params.server === "string" ? params.server : "https://pikibun.test";
let command = String(params.command ?? "ok");
const npm = String(params.npm ?? "ok");
const sent = signal<string[]>([]);
let paired: string | undefined = typeof params.paired === "string" ? params.paired : undefined;
let signedIn = params.piSignedIn !== false;
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

function fakeInstall(): InstallRun {
  sent.update(list => [...list, "install"]);
  const output: ((line: string) => void)[] = [];
  const exits: ((result: { code?: number | null }) => void)[] = [];
  setTimeout(() => {
    const say = (lines: string[]) => { for (const line of lines) for (const listener of output) listener(line); };
    let code = 0;
    if (npm === "missing") { say(["zsh:1: command not found: npm"]); code = 127; }
    else if (npm === "root-cache") {
      say(["npm error code EACCES", "npm error syscall open", "npm error Your cache folder contains root-owned files, due to a bug in", "npm error previous versions of npm which has since been addressed.",
        "npm error To permanently fix this problem, please run:", "npm error   sudo chown -R 501:20 \"/Users/ada/.npm\""]);
      code = 243;
    } else if (npm === "denied") {
      say(["npm error code EACCES", "npm error syscall mkdir", "npm error path /usr/local/lib/node_modules/pikibun", "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/pikibun'"]);
      code = 243;
    } else {
      if (npm === "ok") command = "ok";
      say(["", "added 1 package in 2s"]);
    }
    for (const listener of exits) listener({ code });
  }, 5);
  const global = npm === "elsewhere";
  return {
    line: installCommand("macos", "/bin/zsh", global ? null : appCliFolder("macos", "/Users/ada/Library/Application Support/com.pikibun.app")).line,
    where: global ? "global" : "app",
    onOutput: listener => { output.push(listener); },
    onExit: listener => { exits.push(listener); },
  };
}

setHostLauncher(fakeHost);
setInstaller(fakeInstall);
const host = thisComputer();
mount(() => (
  <View style={{ flex: 1 }}>
    <ThisComputerPanel host={host} server={SERVER} createPairing={async name => {
      sent.update(list => [...list, `pairing ${name}`]);
      return { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", code: "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw" };
    }} />
    <Button testID="fake-terminal-install" label="Install in a terminal" onPress={() => { command = "ok"; }} />
    <Text>{`install error: ${host.installError()}`}</Text>
    <View testID="fake-host-sent">
      <Each of={sent()} key="index">{line => <Text>{`sent ${line()}`}</Text>}</Each>
    </View>
  </View>
));
