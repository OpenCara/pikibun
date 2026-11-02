import type { LocalStartInput, LocalView, Outcome, PikibunBridge, SettingsView } from "../shared/bridge.js";
import { element, setText } from "./dom.js";

declare global { interface Window { pikibun: PikibunBridge } }

const bridge = window.pikibun.settings;
const form = element<HTMLFormElement>("server-form");
const server = element<HTMLInputElement>("server");
const message = element("message");
const useDefault = element<HTMLButtonElement>("default");
const local = {
  status: element("local-status"), facts: element("local-facts"), origin: element("local-origin"), address: element("local-address"),
  addressLabel: element("local-address-label"), host: element("local-host"),
  stateDir: element("local-state-dir"), form: element<HTMLFormElement>("local-form"), githubSaved: element("github-saved"),
  clientId: element<HTMLInputElement>("client-id"), clientSecret: element<HTMLInputElement>("client-secret"),
  message: element("local-message"), start: element<HTMLButtonElement>("local-start"), stop: element<HTMLButtonElement>("local-stop"),
  open: element<HTMLButtonElement>("local-open"), logs: element("local-logs"),
  tabLocal: element<HTMLButtonElement>("tab-local"), tabShared: element<HTMLButtonElement>("tab-shared"),
  localFields: element("local-fields"), sharedFields: element<HTMLFieldSetElement>("shared-fields"),
};
const shared = {
  origin: element<HTMLInputElement>("shared-origin"), listen: element<HTMLSelectElement>("shared-listen"),
  trustProxy: element<HTMLInputElement>("shared-trust-proxy"), signup: element<HTMLSelectElement>("shared-signup"),
  password: element<HTMLInputElement>("shared-password"), admins: element<HTMLTextAreaElement>("shared-admins"),
  githubNote: element("shared-github-note"), githubSaved: element("shared-github-saved"),
  clientId: element<HTMLInputElement>("shared-client-id"), clientSecret: element<HTMLInputElement>("shared-client-secret"),
};
const admin = { form: element<HTMLFormElement>("admin-form"), username: element<HTMLInputElement>("admin-username"), password: element<HTMLInputElement>("admin-password"), create: element<HTMLButtonElement>("admin-create") };
let defaultServer = "";
let busy = false;
/** The tab the owner chose; while Pikibun runs, the way it runs. */
let tab: "local" | "shared" | undefined;
/** The sharing form is filled from the saved settings once, then left to the owner. */
let sharedFilled = false;

function show(target: HTMLElement, text: string, kind: "error" | "saved"): void {
  target.hidden = false;
  target.className = kind === "error" ? "banner error" : "banner note";
  setText(target, text);
}

const serverLabels: Record<LocalView["status"]["state"], string> = { stopped: "Off", starting: "Starting…", running: "Running", stopping: "Stopping…" };
const hostLabels: Record<LocalView["status"]["host"], string> = {
  off: "Not on this computer", waiting: "On this computer, once you have signed in", connecting: "On this computer (connecting…)",
  connected: "On this computer", disconnected: "On this computer (reconnecting…)", stopped: "Stopped", failed: "This computer could not run them",
};

function fillShared(view: LocalView): void {
  const saved = view.inspection?.shared;
  if (sharedFilled || !view.inspection) return;
  sharedFilled = true;
  if (!saved) return;
  shared.origin.value = saved.origin;
  shared.listen.value = saved.listen;
  shared.trustProxy.checked = saved.trustProxy;
  shared.signup.value = saved.signup;
  shared.password.checked = saved.passwordAuth;
  shared.admins.value = saved.admins.join("\n");
}

function render(view: SettingsView): void {
  const { status, inspection, error, notice } = view.local;
  const running = status.state !== "stopped";
  fillShared(view.local);
  // While it runs, the tab is the way it runs; stopped, the owner's choice, else the way it ran last.
  const mode = running && status.mode ? status.mode : tab ?? view.local.mode;
  const isShared = mode === "shared";
  local.tabLocal.setAttribute("aria-pressed", String(!isShared));
  local.tabShared.setAttribute("aria-pressed", String(isShared));
  local.tabLocal.disabled = busy || (running && isShared);
  local.tabShared.disabled = busy || (running && !isShared);
  local.localFields.hidden = isShared;
  local.sharedFields.hidden = !isShared;
  local.sharedFields.disabled = running;

  setText(local.status, status.state === "running" && status.mode === "shared" ? "Shared" : serverLabels[status.state]);
  local.status.dataset.state = status.state === "running" ? "connected" : "";
  local.facts.hidden = !running && !inspection;
  setText(local.origin, status.origin ?? (isShared ? inspection?.shared?.origin ?? "Not set up yet" : `http://127.0.0.1:${inspection?.port ?? 7878}`));
  const address = status.address ?? `http://${isShared && inspection?.shared?.listen === "all" ? "0.0.0.0" : "127.0.0.1"}:${inspection?.port ?? 7878}`;
  setText(local.address, isShared ? `${address} — your proxy or tunnel forwards the public address here` : address);
  setText(local.host, running ? hostLabels[status.host] : inspection?.hostProblem ? `Not on this computer: ${inspection.hostProblem}`
    : inspection?.hostMode === "unsandboxed" ? "On this computer, without a sandbox (asks for your consent)" : "On this computer");
  setText(local.stateDir, inspection?.stateDir ?? "");
  local.githubSaved.hidden = !inspection?.githubClientId;
  setText(local.githubSaved, inspection?.githubClientId ? `Saved: client ID ${inspection.githubClientId}. Enter both again only to replace it.` : "");
  const sharedClient = inspection?.shared?.githubClientId;
  shared.githubSaved.hidden = !sharedClient;
  setText(shared.githubSaved, sharedClient ? `Saved: client ID ${sharedClient}. Enter both again only to replace it.` : "");
  const origin = shared.origin.value.trim().replace(/\/+$/, "") || "https://…";
  setText(shared.githubNote, `GitHub sign-in needs an OAuth app of its own for the public address, with the authorization callback URL ${origin}/api/auth/github/callback. Leave these empty with usernames and passwords only.`);

  setText(local.start, isShared ? "Share from This Computer" : "Run on This Computer");
  local.start.hidden = running;
  local.stop.hidden = !running;
  local.open.hidden = status.state !== "running";
  local.start.disabled = busy;
  local.stop.disabled = busy || status.state === "stopping";
  for (const input of [local.clientId, local.clientSecret]) input.disabled = running;

  // Password administrators are created on the running shared server.
  const passwordAdmins = status.state === "running" && status.mode === "shared" && inspection?.shared?.passwordAuth === true;
  admin.form.hidden = !passwordAdmins;
  admin.create.disabled = busy;
  if (passwordAdmins && !admin.username.value) {
    const first = inspection?.shared?.admins.find(id => id.startsWith("password:"));
    if (first) admin.username.value = first.slice("password:".length);
  }

  if (error) show(local.message, error, "error");
  else if (notice) show(local.message, notice, "saved");
  else if (status.state === "running" && status.claimUrl) show(local.message, "Running. The Pikibun window opened its sign-in: the GitHub account you sign in with becomes its owner, and the only one that can sign in.", "saved");
  else if (status.state === "running" && status.mode === "shared") show(local.message, `Shared at ${status.origin}. Once your proxy or tunnel forwards it to ${status.address}, people sign in there; invite them from a workspace's Members.`, "saved");
  else local.message.hidden = true;
  const logs = view.local.logs.slice(-30);
  local.logs.hidden = logs.length === 0;
  local.logs.replaceChildren(...logs.map(line => {
    const item = document.createElement("li");
    item.className = line.level;
    const time = document.createElement("time");
    time.textContent = new Date(line.time).toLocaleTimeString();
    const text = document.createElement("span");
    text.textContent = line.message;
    item.append(time, text);
    return item;
  }));
}

async function save(origin: string): Promise<void> {
  const outcome = await bridge.setServer(origin);
  if (!outcome.ok) { show(message, outcome.error, "error"); return; }
  const view = await bridge.view();
  server.value = view.server;
  show(message, view.local.status.state === "running"
    ? "Saved. The Pikibun window opens this server once you stop Pikibun on this computer." : "Saved. The Pikibun window now opens this server.", "saved");
}

async function run(action: () => Promise<Outcome>, clear: HTMLInputElement[]): Promise<void> {
  busy = true;
  render(await bridge.view());
  try {
    const outcome = await action();
    // Saved secrets are used from now on: an ID left in its field would come back with no secret at the next start.
    if (outcome.ok) for (const input of clear) input.value = "";
    const view = await bridge.view();
    render(view);
    if (!outcome.ok) show(local.message, outcome.error, "error");
  } finally {
    busy = false;
    render(await bridge.view());
  }
}

function startInput(): LocalStartInput {
  if (local.sharedFields.hidden) {
    const clientId = local.clientId.value.trim();
    const clientSecret = local.clientSecret.value.trim();
    // An ID without a secret means the saved app; the page asks for both only to replace it.
    return { mode: "local", ...(clientSecret ? { github: { clientId, clientSecret } } : {}) };
  }
  const clientId = shared.clientId.value.trim();
  const clientSecret = shared.clientSecret.value.trim();
  return { mode: "shared", shared: {
    origin: shared.origin.value.trim().replace(/\/+$/, ""), listen: shared.listen.value === "all" ? "all" : "loopback", trustProxy: shared.trustProxy.checked,
    signup: shared.signup.value === "open" ? "open" : shared.signup.value === "off" ? "off" : "invite", passwordAuth: shared.password.checked,
    admins: shared.admins.value.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean),
    ...(clientSecret ? { github: { clientId, clientSecret } } : {}),
  } };
}

const choose = (next: "local" | "shared") => { tab = next; void bridge.view().then(render); };
local.tabLocal.addEventListener("click", () => choose("local"));
local.tabShared.addEventListener("click", () => choose("shared"));
shared.origin.addEventListener("input", () => { void bridge.view().then(render); });
form.addEventListener("submit", event => { event.preventDefault(); void save(server.value); });
useDefault.addEventListener("click", () => { server.value = defaultServer; void save(defaultServer); });
local.form.addEventListener("submit", event => {
  event.preventDefault();
  const input = startInput();
  void run(() => bridge.startLocal(input), [local.clientId, local.clientSecret, shared.clientId, shared.clientSecret]);
});
local.stop.addEventListener("click", () => { void run(() => bridge.stopLocal(), []); });
local.open.addEventListener("click", () => { void run(() => bridge.openLocal(), []); });
admin.form.addEventListener("submit", event => {
  event.preventDefault();
  const input = { username: admin.username.value, password: admin.password.value };
  // The password stays only as long as the request.
  admin.password.value = "";
  void run(() => bridge.createAdmin(input), [admin.username]);
});
bridge.onUpdate(render);
void bridge.view().then(view => { server.value = view.server; defaultServer = view.defaultServer; render(view); });
