import { host as embedder, mount, signal, Text, View } from "nsh";
import type { HostInspection } from "../../../../packages/shared/src/app-host-protocol";
import type { ServerInspection } from "../../../../packages/shared/src/app-server-protocol";
import { appCliFolder, installCommand, setCommandUpdate, setHostLauncher, setInstaller, type HostLink, type InstallRun } from "../../src/lib/this-computer";
import { setServerLauncher, thisServer } from "../../src/lib/this-server";
import { Root } from "../../src/Root";
import { ThisServerPanel } from "../../src/settings/SelfHost";

const LOCAL = "http://127.0.0.1:7878";
const SIGN_IN_TOKEN = "c".repeat(43);
const params = embedder.params as { app?: unknown; command?: unknown; sandboxed?: unknown; hostProblem?: unknown; appVersion?: unknown; ownCopy?: unknown; noToken?: unknown };
let command = String(params.command ?? "ok");
const sent = signal<string[]>([]);
if (typeof params.appVersion === "string") {
  const ownCopy = typeof params.ownCopy === "string" ? params.ownCopy : null;
  setCommandUpdate({ appVersion: params.appVersion, ownCopy: async () => ownCopy });
}

function link(answer: (request: { type: string; id: number; [key: string]: unknown }, emit: (value: unknown) => void) => void, refuse: () => string[] | null): HostLink {
  const messages: ((value: unknown) => void)[] = [];
  const output: ((line: string) => void)[] = [];
  const exits: ((result: { code?: number | null }) => void)[] = [];
  let ended = false;
  const emit = (value: unknown) => setTimeout(() => { if (!ended) for (const listener of messages) listener(value); }, 1);
  const exit = (code: number) => setTimeout(() => { ended = true; for (const listener of exits) listener({ code }); }, 1);
  setTimeout(() => {
    const lines = refuse();
    if (lines) { for (const line of lines) for (const listener of output) listener(line); exit(lines[0]!.includes("not found") ? 127 : 1); return; }
    emit({ type: "ready" });
  }, 1);
  return {
    send: message => answer(message as { type: string; id: number }, emit),
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onExit: listener => { exits.push(listener); },
    end: () => exit(0),
    kill: () => exit(1),
  };
}

const inspection = (): ServerInspection => ({
  stateDir: "/Users/ada/.local/share/pikibun/server", port: 7878,
  hostMode: params.sandboxed === true ? "sandboxed" : "unsandboxed",
  ...(params.sandboxed === true ? {} : { unsandboxedWarning: "WARNING: running WITHOUT a sandbox." }),
  ...(typeof params.hostProblem === "string" ? { hostProblem: params.hostProblem } : {}),
});

setServerLauncher(() => link((request, emit) => {
  const { id: _id, ...shown } = request;
  sent.update(list => [...list, JSON.stringify(shown)]);
  const reply = (extra: object = {}) => emit({ type: "result", id: request.id, ok: true, ...extra });
  if (request.type === "inspect") reply({ inspection: inspection() });
  else if (request.type === "start") {
    if (command === "old") { emit({ type: "result", id: request.id, ok: false, error: { message: "Add your GitHub OAuth app first: Pikibun signs you in with it." } }); return; }
    emit({ type: "status", state: "running", origin: LOCAL, ...(params.noToken === true ? {} : { signInToken: SIGN_IN_TOKEN }), host: "waiting" });
    emit({ type: "log", level: "info", message: `Pikibun is running at ${LOCAL}, reachable from this computer only.` });
    reply();
  } else if (request.type === "stop") {
    emit({ type: "status", state: "stopping", origin: LOCAL, host: "off" });
    emit({ type: "status", state: "stopped", host: "off" });
    reply();
  } else reply();
}, () => command === "missing" ? ["zsh:1: command not found: pikibun"]
  : command === "outdated" ? ["Pikibun failed. Check --help, the state directory's permissions, the port, local Pi configuration and sandbox prerequisites."] : null));

const hostInspection: HostInspection = { platform: "darwin", stateDir: "/Users/ada/.local/share/pikibun/connector", mode: "unsandboxed", prerequisites: [], models: [] };
setHostLauncher(() => link((request, emit) => {
  emit({ type: "result", id: request.id, ok: true, ...(request.type === "inspect" ? { inspection: hostInspection } : {}), ...(request.type === "providers" ? { providers: [] } : {}) });
}, () => null));

setInstaller((): InstallRun => {
  sent.update(list => [...list, "install"]);
  const exits: ((result: { code?: number | null }) => void)[] = [];
  setTimeout(() => { command = "ok"; for (const listener of exits) listener({ code: 0 }); }, 5);
  return {
    line: installCommand("macos", "/bin/zsh", appCliFolder("macos", "/Users/ada/Library/Application Support/com.pikibun.app")).line,
    where: "app",
    onOutput: () => undefined,
    onExit: listener => { exits.push(listener); },
  };
});

if (params.app === true) mount(Root);
else {
  const used = signal("");
  mount(() => (
    <View style={{ flex: 1 }}>
      <ThisServerPanel server={thisServer()} onUse={origin => used.set(origin)} />
      <Text>{`used: ${used()}`}</Text>
      <Text>{`sign-in token: ${thisServer().signInTokenFor(LOCAL) ?? "none"}`}</Text>
      <View testID="fake-server-sent">
        <Each of={sent()} key="index">{line => <Text>{`sent ${line()}`}</Text>}</Each>
      </View>
    </View>
  ));
}
