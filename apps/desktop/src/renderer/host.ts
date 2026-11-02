import { stateLabels, type HostsView, type HostView, type LoginMethodType, type ModelChoice, type Outcome, type PikibunBridge, type PrerequisiteFix, type SandboxChoice, type SetupAction, type SignInView } from "../shared/bridge.js";
import { element, setText } from "./dom.js";

declare global { interface Window { pikibun: PikibunBridge } }

const bridge = window.pikibun.host;

const title = element("title");
const summary = element("summary");
const servers = element("servers");
const addForm = element<HTMLFormElement>("add-form");
const addServer = element<HTMLInputElement>("add-server");
const add = element<HTMLButtonElement>("add");
const status = element("status");
const error = element("error");
const start = element<HTMLButtonElement>("start");
const stop = element<HTMLButtonElement>("stop");
const open = element<HTMLButtonElement>("open");
const refresh = element<HTMLButtonElement>("refresh");
const remove = element<HTMLButtonElement>("remove");
const form = element<HTMLFormElement>("pair-form");
const pairingId = element<HTMLInputElement>("pairing-id");
const pairingCode = element<HTMLInputElement>("pairing-code");
const replace = element<HTMLInputElement>("replace");
const pair = element<HTMLButtonElement>("pair");
const modelsSave = element<HTMLButtonElement>("models-save");
const modelsPi = element<HTMLButtonElement>("models-pi");
const openAtLogin = element<HTMLInputElement>("open-at-login");
const sandboxSelect = element<HTMLSelectElement>("sandbox");
const distroSelect = element<HTMLSelectElement>("distro");
const signInProvider = element<HTMLSelectElement>("sign-in-provider");
const signInMethod = element<HTMLSelectElement>("sign-in-method");
const signInStart = element<HTMLButtonElement>("sign-in-start");
const signInPrompt = element<HTMLFormElement>("sign-in-prompt");
const signInAnswer = element<HTMLInputElement>("sign-in-answer");
const signInChoice = element<HTMLSelectElement>("sign-in-choice");
const signInCancel = element<HTMLButtonElement>("sign-in-cancel");
let busy = false;
/** Connections whose Pi providers this page has asked for, once each. */
const providersAsked = new Set<string>();
/** The sign-in question the form shows, so a re-render keeps what the owner is typing. */
let shownPrompt: number | undefined;
let current: HostsView | undefined;
/** The connection the page shows; the primary one until the owner picks another. */
let selected: string | undefined;
/** A local failure (validation, a refused start) shown until the next view says otherwise. */
let localError: string | undefined;
/** The models' checkboxes as the owner left them, until saved or the connection changes. */
let modelDraft: { id: string; loaded: boolean; checked: Set<string> } | undefined;

const modelKey = (model: ModelChoice) => `${model.provider}/${model.modelId}`;
const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

function item(text: string, detail?: string, mark?: "ok" | "missing"): HTMLLIElement {
  const li = document.createElement("li");
  if (mark) { const icon = li.appendChild(document.createElement("span")); icon.className = `mark ${mark}`; icon.textContent = mark === "ok" ? "✓" : "✕"; icon.setAttribute("aria-label", mark === "ok" ? "Present" : "Missing"); }
  li.appendChild(document.createElement("span")).textContent = text;
  if (detail) { const small = li.appendChild(document.createElement("span")); small.className = "muted"; small.textContent = detail; }
  return li;
}

/** How the host's sessions are isolated: as it runs, else as it would start. */
function isolationText(view: HostView): string {
  const inspection = view.inspection;
  if (inspection?.unsupported) return inspection.unsupported;
  const mode = view.running ? (view.running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  const sandbox = view.running ? view.running.sandbox : inspection?.sandbox;
  const wsl = view.windows?.sandbox === "wsl2";
  if (mode === "sandboxed") {
    if (sandbox === "windows") return "Sandboxed (experimental): agent work runs in Windows' own process containers, through Microsoft's MXC SDK.";
    if (sandbox === "seatbelt") return "Sandboxed (experimental): agent work runs in macOS's Seatbelt sandbox.";
    return wsl ? "Sandboxed: agent work runs in WSL2's bubblewrap sandbox, verified per session." : "Sandboxed: agent work runs in bubblewrap, verified per session.";
  }
  if (mode === "unsandboxed") return `Unsandboxed: agent work runs directly as you ${wsl ? "in WSL2" : "on this computer"}, after your consent.`;
  return "…";
}

const sandboxOptions = {
  windows: [["wsl2", "WSL2 (bubblewrap)"], ["native", "Native Windows (experimental)"]],
  mac: [["none", "None (unsandboxed, after your consent)"], ["seatbelt", "macOS sandbox (experimental)"]],
} as const;

/** The Sandbox select's options, of this computer's kind; replaced only when the kind changes. */
function setSandboxOptions(kind: keyof typeof sandboxOptions): void {
  if (sandboxSelect.dataset.kind === kind) return;
  sandboxSelect.dataset.kind = kind;
  sandboxSelect.replaceChildren(...sandboxOptions[kind].map(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    return option;
  }));
}

const macSandboxNote = {
  seatbelt: "Sessions run in macOS's own Seatbelt sandbox (experimental: macOS 15 or later with the developer tools, xcode-select --install; Prerequisites below lists what is missing), or, while it isn't ready, without one after your consent. Each session sees only its own files and reaches the network only through its egress proxy. macOS can't limit a session's memory or processes, so shell commands run only in your own sessions on this host.",
  none: "Sessions run directly as you on this Mac, after your consent at each start: approved commands can read and change anything you can. Choose macOS sandbox to isolate them instead.",
} as const;

/** Windows: where the host's sessions run, WSL2 (in which distribution) or native Windows. macOS: its sandbox or none. */
function renderSandbox(view: HostsView, connection: HostView): void {
  const choice = connection.windows ?? connection.mac;
  element("sandbox-row").hidden = !choice;
  if (!choice) return;
  const stopped = connection.state === "stopped";
  setSandboxOptions(connection.windows ? "windows" : "mac");
  if (document.activeElement !== sandboxSelect) sandboxSelect.value = choice.sandbox;
  sandboxSelect.disabled = busy || !stopped;
  if (choice.sandbox === "seatbelt" || choice.sandbox === "none") {
    element("distro-row").hidden = true;
    setText(element("sandbox-note"), macSandboxNote[choice.sandbox]);
    return;
  }
  const distros = view.wsl?.distros ?? [];
  element("distro-row").hidden = choice.sandbox !== "wsl2";
  const fallback = distros.find(distro => distro.default && distro.version === 2) ?? distros.find(distro => distro.version === 2);
  const options: [string, string, boolean][] = [["", fallback ? `WSL's default (${fallback.name})` : "WSL's default", false],
    ...distros.map(distro => [distro.name, `${distro.name}${distro.version === 2 ? "" : " (WSL 1: no sandbox)"}`, distro.version !== 2] as [string, string, boolean])];
  // A chosen distribution this computer no longer lists stays visible, so the choice isn't silently changed.
  const chosen = choice.sandbox === "wsl2" ? choice.distro : undefined;
  if (chosen && !distros.some(distro => distro.name === chosen)) options.push([chosen, `${chosen} (not found)`, true]);
  const key = JSON.stringify(options);
  if (distroSelect.dataset.options !== key) {
    distroSelect.dataset.options = key;
    distroSelect.replaceChildren(...options.map(([value, text, disabled]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.disabled = disabled && value !== chosen;
      return option;
    }));
  }
  if (document.activeElement !== distroSelect) distroSelect.value = chosen ?? "";
  distroSelect.disabled = busy || !stopped;
  setText(element("sandbox-note"), choice.sandbox === "wsl2"
    ? "Sessions run in WSL2's bubblewrap sandbox, using Node.js, Pi's models and the connector's pairing inside that distribution, as `pikibun connect` run there does. Pikibun copies its connector into WSL2 at the first start."
    : "Sessions run in Windows' own sandbox (experimental: Windows 11 24H2 or later with the October 2026 update, Git for Windows, busybox-w32 and Microsoft's MXC SDK; Prerequisites below lists what is missing), or, while it isn't ready, without one after your consent. Native Windows uses Pi's models and the connector's pairing in your Windows profile.");
}

const actionLabels: Record<SetupAction["kind"], string> = {
  "xcode-tools": "Install Developer Tools", "git-for-windows": "Install Git", "mxc-sdk": "Install MXC SDK",
  "windows-update": "Open Windows Update", "wsl-install": "Install WSL", "wsl-node": "Install Node.js 24", apt: "Install Packages",
};

function button(text: string, className: string, click: () => void): HTMLButtonElement {
  const made = document.createElement("button");
  made.type = "button";
  made.className = className;
  made.textContent = text;
  made.disabled = busy;
  made.addEventListener("click", click);
  return made;
}

/** How to get something missing: what to do, its command to copy, and what Pikibun can do (after asking) or open. */
function fixBlock(fix: PrerequisiteFix): HTMLElement {
  const box = document.createElement("div");
  box.className = "fix";
  const text = box.appendChild(document.createElement("span"));
  text.className = "muted";
  text.textContent = fix.text;
  if (fix.command) {
    const command = box.appendChild(document.createElement("code"));
    command.className = "command";
    command.textContent = fix.command;
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const action = fix.action;
  if (action) actions.appendChild(button(actionLabels[action.kind], "primary", () => { void act(() => bridge.setup(id(), action)); }));
  const url = fix.url;
  if (url) actions.appendChild(button("Open Page", "ghost", () => { void act(() => bridge.openLink(id(), url)); }));
  if (actions.childElementCount) box.appendChild(actions);
  return box;
}

/** The prerequisites, each missing one with its fix; a fix shared by several (Linux packages) is shown once. */
function renderPrerequisites(connection: HostView): void {
  const inspection = connection.inspection;
  const shown = new Set<string>();
  element("prerequisites").replaceChildren(...(inspection?.prerequisites ?? []).map(entry => {
    const li = item(entry.name, undefined, entry.ok ? "ok" : "missing");
    const key = entry.fix && JSON.stringify(entry.fix);
    if (!entry.ok && entry.fix && key && !shown.has(key)) { shown.add(key); li.appendChild(fixBlock(entry.fix)); }
    return li;
  }));
  const unsupported = element("unsupported-fix");
  unsupported.hidden = !inspection?.unsupportedFix;
  unsupported.replaceChildren(...(inspection?.unsupportedFix ? [fixBlock(inspection.unsupportedFix)] : []));
}

/** A select's options, replaced only when they change, so an open select isn't reset by a re-render. */
function setOptions(select: HTMLSelectElement, options: [value: string, text: string][]): void {
  const key = JSON.stringify(options);
  if (select.dataset.options === key) return;
  select.dataset.options = key;
  const previous = select.value;
  select.replaceChildren(...options.map(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    return option;
  }));
  if (options.some(([value]) => value === previous)) select.value = previous;
}

function signInStatus(signIn: SignInView): string {
  if (signIn.state === "running") return `Signing in to ${signIn.name}…`;
  if (signIn.state === "done") return `Pi is signed in to ${signIn.name} on this computer. Its models are listed above.`;
  if (signIn.state === "cancelled") return "Sign-in cancelled.";
  return signIn.error ?? "Sign-in failed.";
}

function notice(entry: SignInView["notices"][number]): HTMLLIElement {
  const li = document.createElement("li");
  const text = (value: string, className = "") => { const span = li.appendChild(document.createElement("span")); span.className = className; span.textContent = value; };
  const open = (url: string, title: string) => { const actions = li.appendChild(document.createElement("div")); actions.className = "actions"; actions.appendChild(button(title, "ghost", () => { void bridge.openLink(id(), url); })); };
  if (entry.kind === "auth-url") {
    text(entry.instructions ?? "Sign in on the page that opened in your browser.");
    if (URL.parse(entry.url)?.protocol === "https:") open(entry.url, "Open Sign-In Page Again");
    else text(entry.url, "muted");
  } else if (entry.kind === "device-code") {
    text("Enter this code on the page that opened in your browser:");
    text(entry.userCode, "device-code");
    open(entry.verificationUri, "Open Page Again");
  } else {
    text(entry.message, entry.kind === "progress" ? "muted" : "");
    if (entry.kind === "info") for (const link of entry.links ?? []) open(link.url, link.label ?? "Open Page");
  }
  return li;
}

/** Pi's sign-in to a provider on this host: which one and how, then what the flow shows and asks. */
function renderSignIn(connection: HostView): void {
  if (!connection.providers && !providersAsked.has(connection.id)) {
    providersAsked.add(connection.id);
    void bridge.providers(connection.id);
  }
  const providers = connection.providers ?? [];
  const signIn = connection.signIn;
  const running = signIn?.state === "running";
  setOptions(signInProvider, providers.map(provider => [provider.id, `${provider.name}${provider.signedIn ? " (signed in)" : ""}`]));
  const chosen = providers.find(provider => provider.id === signInProvider.value) ?? providers[0];
  setOptions(signInMethod, (chosen?.methods ?? []).map(method => [method.type, `${method.name}${method.subscription ? " (subscription)" : ""}`]));
  for (const control of [signInProvider, signInMethod]) control.disabled = running || !providers.length;
  signInStart.disabled = running || !chosen;
  setText(element("sign-in-note"), connection.providers && !providers.length
    ? "Pi on this computer offers no provider to sign in to."
    : "Pikibun runs Pi's own sign-in here, as Pi's /login does: the credential is saved in Pi's configuration on this computer and never sent to Pikibun. No separate Pi install is needed.");

  element("sign-in-flow").hidden = !signIn;
  signInCancel.hidden = !running;
  if (!signIn) return;
  setText(element("sign-in-status"), signInStatus(signIn));
  element("sign-in-notices").replaceChildren(...(running ? signIn.notices : []).map(notice));
  const prompt = signIn.prompt;
  signInPrompt.hidden = !prompt;
  if (!prompt) { shownPrompt = undefined; return; }
  if (shownPrompt === prompt.id) return;
  // A new question: an empty field (or the first option) and the owner's attention.
  shownPrompt = prompt.id;
  const detail = prompt.detail;
  setText(element("sign-in-question"), detail.message);
  signInAnswer.hidden = detail.type === "select";
  signInChoice.hidden = detail.type !== "select";
  if (detail.type === "select") {
    setOptions(signInChoice, detail.options.map(option => [option.id, option.description ? `${option.label} — ${option.description}` : option.label]));
    signInChoice.focus();
  } else {
    signInAnswer.value = "";
    signInAnswer.type = detail.type === "secret" ? "password" : "text";
    signInAnswer.placeholder = detail.placeholder ?? "";
    signInAnswer.focus();
  }
}

function label(view: HostView): string {
  return view.error && view.state === "stopped" ? "Stopped (error)" : stateLabels[view.state];
}

function renderServers(view: HostsView, connection: HostView): void {
  servers.replaceChildren(...view.connections.map(entry => {
    const li = document.createElement("li");
    const button = li.appendChild(document.createElement("button"));
    button.type = "button";
    button.className = "server";
    button.setAttribute("aria-current", String(entry.id === connection.id));
    const name = button.appendChild(document.createElement("span"));
    name.textContent = `${hostOf(entry.server)}${entry.primary ? " (primary)" : ""}`;
    name.title = entry.server;
    const pill = button.appendChild(document.createElement("span"));
    pill.className = "pill";
    pill.dataset.state = entry.state === "connected" ? "connected" : entry.error && entry.state === "stopped" ? "disconnected" : "";
    pill.textContent = label(entry);
    button.addEventListener("click", () => { selected = entry.id; localError = undefined; render(view); });
    return li;
  }));
}

function renderModels(connection: HostView): void {
  const inspection = connection.inspection;
  const models = element("models");
  const note = element("models-note");
  const available = inspection?.models ?? [];
  if (modelDraft?.id !== connection.id || (!modelDraft.loaded && inspection)) {
    const chosen = connection.models ? new Set(connection.models.map(modelKey)) : new Set(available.map(modelKey));
    modelDraft = { id: connection.id, loaded: !!inspection, checked: chosen };
  }
  const draft = modelDraft;
  models.replaceChildren(...available.map(model => {
    const li = document.createElement("li");
    const row = li.appendChild(document.createElement("label"));
    row.className = "check";
    const box = row.appendChild(document.createElement("input"));
    box.type = "checkbox";
    box.checked = draft.checked.has(modelKey(model));
    box.disabled = busy;
    box.addEventListener("change", () => { if (box.checked) draft.checked.add(modelKey(model)); else draft.checked.delete(modelKey(model)); });
    const text = row.appendChild(document.createElement("span"));
    text.textContent = model.name;
    const detail = row.appendChild(document.createElement("span"));
    detail.className = "muted";
    detail.textContent = ` ${model.provider}/${model.modelId}${model.thinkingLevel ? ` · starts at ${model.thinkingLevel}` : ""}`;
    return li;
  }));
  const missing = connection.models?.filter(model => !available.some(entry => modelKey(entry) === modelKey(model))) ?? [];
  setText(note, !inspection ? "Checking Pi's models…" : inspection.modelsError ? `${inspection.modelsError} Sign Pi in to a provider below.` : (available.length
    ? `${connection.models ? `Offering only the checked models to ${hostOf(connection.server)}${missing.length ? ` (${missing.map(modelKey).join(", ")} no longer configured in Pi)` : ""}.` : "Pi chooses: its enabledModels setting, or every model with configured authentication."} Pikibun never receives your provider credentials. A change applies from the host's next start.`
    : ""));
  element("models-actions").hidden = !available.length;
  modelsSave.disabled = busy;
  modelsPi.disabled = busy || !connection.models;
}

function render(view: HostsView): void {
  current = view;
  const connection = view.connections.find(entry => entry.id === selected) ?? view.connections[0];
  if (!connection) return;
  selected = connection.id;
  const inspection = connection.inspection;
  const stopped = connection.state === "stopped";
  document.title = view.title;
  setText(title, view.title);
  const online = view.connections.filter(entry => entry.state === "connected").length;
  setText(summary, view.connections.length === 1 ? label(connection) : `${online} of ${view.connections.length} online`);
  summary.dataset.state = online ? "connected" : "";
  element("development").hidden = !view.fixtureModels;
  renderServers(view, connection);
  add.disabled = busy;

  setText(element("connection-heading"), `Host for ${hostOf(connection.server)}`);
  setText(status, label(connection));
  status.dataset.state = connection.state;
  const message = localError ?? connection.error;
  error.hidden = !message;
  setText(error, message ?? "");

  setText(element("server"), connection.server);
  const paired = inspection?.pairedServer;
  setText(element("paired"), inspection ? paired ?? inspection.pairingError ?? "Not paired yet" : "…");
  setText(element("isolation"), isolationText(connection));
  setText(element("state-dir"), inspection?.stateDir || (inspection ? "—" : "…"));
  renderSandbox(view, connection);
  setText(element("command"), connection.command);

  start.disabled = busy || !stopped || !inspection || !paired || !!inspection.unsupported;
  stop.disabled = busy || stopped || connection.state === "stopping";
  refresh.disabled = connection.inspecting;
  remove.hidden = connection.primary;
  remove.disabled = busy;
  for (const input of [pairingId, pairingCode, replace]) input.disabled = busy || !stopped;
  pair.disabled = busy || !stopped || !!inspection?.unsupported;
  // A saved pairing that can't be read (another server's, a damaged file) can still be replaced with a new code.
  element("replace-row").hidden = !paired && !inspection?.pairingError;
  setText(element("pair-note"), `In Pikibun at ${connection.server}, open Settings › Hosts and create a pairing code. Enter its pairing ID and single-use code here: the code goes only to the host on this computer, never to a file or log.`);
  setText(element("pair-server"), `Pairs with ${connection.server}`);
  element("login-row").hidden = view.openAtLogin === undefined;
  openAtLogin.checked = view.openAtLogin === true;

  renderModels(connection);

  const prerequisitesNote = element("prerequisites-note");
  const sandboxMissing = inspection?.sandboxPrerequisites?.filter(entry => !entry.ok).map(entry => entry.name);
  prerequisitesNote.hidden = !sandboxMissing?.length && !inspection?.prerequisitesError;
  setText(prerequisitesNote, inspection?.prerequisitesError ?? (sandboxMissing?.length ? `The isolated sandbox needs ${sandboxMissing.join(", ")}; without it the host runs unsandboxed.` : ""));
  renderPrerequisites(connection);
  renderSignIn(connection);

  const logs = element("logs");
  logs.replaceChildren(...connection.logs.slice(-100).reverse().map(line => {
    const li = document.createElement("li");
    li.className = line.level;
    const time = li.appendChild(document.createElement("time"));
    time.dateTime = new Date(line.time).toISOString();
    time.textContent = new Date(line.time).toLocaleTimeString();
    li.appendChild(document.createElement("span")).textContent = line.message;
    return li;
  }));
  if (!connection.logs.length) logs.replaceChildren(item("Nothing yet."));
}

/** Runs one owner action at a time, keeping the buttons disabled until it settles. */
async function act(run: () => Promise<Outcome | void>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  localError = undefined;
  if (current) render(current);
  try {
    const outcome = await run();
    if (outcome && !outcome.ok) localError = outcome.error;
    return !outcome || outcome.ok;
  } finally {
    busy = false;
    render(await bridge.view());
  }
}

const id = () => selected ?? current?.connections[0]?.id ?? "default";
start.addEventListener("click", () => { void act(() => bridge.start(id(), { replacePairing: false })); });
stop.addEventListener("click", () => { void act(() => bridge.stop(id())); });
open.addEventListener("click", () => { void act(() => bridge.open(id())); });
refresh.addEventListener("click", () => { void act(() => bridge.refresh(id())); });
remove.addEventListener("click", () => {
  const server = current?.connections.find(entry => entry.id === id())?.server ?? "this server";
  if (!window.confirm(`Remove ${server}? Its host stops, and this computer stays paired in its state directory: remove the host in that Pikibun's Settings › Hosts too.`)) return;
  void act(async () => {
    const outcome = await bridge.remove(id());
    if (outcome.ok) selected = undefined;
    return outcome;
  });
});
addForm.addEventListener("submit", event => {
  event.preventDefault();
  const before = new Set(current?.connections.map(entry => entry.id));
  void act(() => bridge.add(addServer.value)).then(async added => {
    if (!added) return;
    addServer.value = "";
    // Show the new server, ready to pair.
    const view = await bridge.view();
    selected = view.connections.find(entry => !before.has(entry.id))?.id ?? selected;
    render(view);
    pairingId.focus();
  });
});
form.addEventListener("submit", event => {
  event.preventDefault();
  const pairing = { id: pairingId.value, code: pairingCode.value };
  void act(() => bridge.start(id(), { pairing, replacePairing: replace.checked })).then(started => {
    // The code is single use: once the host has it, nothing here keeps it.
    if (started) { pairingCode.value = ""; pairingId.value = ""; replace.checked = false; }
  });
});
modelsSave.addEventListener("click", () => {
  const connection = current?.connections.find(entry => entry.id === id());
  const available = connection?.inspection?.models ?? [];
  const checked = available.filter(model => modelDraft?.checked.has(modelKey(model))).map(model => ({ provider: model.provider, modelId: model.modelId }));
  void act(() => bridge.setModels(id(), checked)).then(() => { modelDraft = undefined; });
});
modelsPi.addEventListener("click", () => { void act(() => bridge.setModels(id(), null)).then(() => { modelDraft = undefined; }); });
openAtLogin.addEventListener("change", () => { void act(() => bridge.setOpenAtLogin(openAtLogin.checked)); });
const chooseSandbox = () => {
  const value = sandboxSelect.value;
  const choice: SandboxChoice = value === "native" || value === "seatbelt" || value === "none" ? { sandbox: value }
    : { sandbox: "wsl2", ...(distroSelect.value ? { distro: distroSelect.value } : {}) };
  void act(() => bridge.setSandbox(id(), choice));
};
signInProvider.addEventListener("change", () => { if (current) render(current); });
signInStart.addEventListener("click", () => {
  const method = signInMethod.value as LoginMethodType;
  localError = undefined;
  // Not through act(): the sign-in lasts until the owner finishes it in the browser, and answering must stay possible.
  void bridge.signIn(id(), signInProvider.value, method);
});
signInPrompt.addEventListener("submit", event => {
  event.preventDefault();
  const prompt = current?.connections.find(entry => entry.id === id())?.signIn?.prompt;
  if (!prompt) return;
  const value = prompt.detail.type === "select" ? signInChoice.value : signInAnswer.value;
  signInAnswer.value = "";
  void bridge.answerSignIn(id(), prompt.id, value).then(outcome => {
    if (!outcome.ok) { localError = outcome.error; if (current) render(current); }
  });
});
signInCancel.addEventListener("click", () => { void bridge.cancelSignIn(id()); });
sandboxSelect.addEventListener("change", chooseSandbox);
distroSelect.addEventListener("change", chooseSandbox);

bridge.onUpdate(view => { if (!busy) render(view); else current = view; });
void bridge.view().then(render);
