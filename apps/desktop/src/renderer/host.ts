import { stateLabels, type HostsView, type HostView, type ModelChoice, type Outcome, type PikibunBridge } from "../shared/bridge.js";
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
let busy = false;
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
  setText(note, !inspection ? "Checking Pi's models…" : inspection.modelsError ?? (available.length
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
  const isolation = connection.running ? (connection.running.unsandboxed ? "unsandboxed" : "sandboxed") : inspection?.mode;
  setText(element("isolation"), inspection?.unsupported ?? (isolation === "sandboxed"
    ? "Sandboxed: agent work runs in bubblewrap, verified per session."
    : isolation === "unsandboxed" ? "Unsandboxed: agent work runs directly as you on this computer, after your consent." : "…"));
  setText(element("state-dir"), inspection?.stateDir ?? "…");
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

  const prerequisites = element("prerequisites");
  const prerequisitesNote = element("prerequisites-note");
  const sandboxMissing = inspection?.sandboxPrerequisites?.filter(entry => !entry.ok).map(entry => entry.name);
  prerequisitesNote.hidden = !sandboxMissing?.length && !inspection?.prerequisitesError;
  setText(prerequisitesNote, inspection?.prerequisitesError ?? (sandboxMissing?.length ? `The isolated sandbox needs ${sandboxMissing.join(", ")}; without it the host runs unsandboxed.` : ""));
  prerequisites.replaceChildren(...(inspection?.prerequisites ?? []).map(entry => item(entry.name, undefined, entry.ok ? "ok" : "missing")));

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

bridge.onUpdate(view => { if (!busy) render(view); else current = view; });
void bridge.view().then(render);
