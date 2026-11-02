import { useEffect, useState, type FormEvent } from "react";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { normalizeExtensionSource, type ExtensionAvailability, type HostExtensionsReport, type InstalledExtension } from "../../../../packages/shared/src/host-extensions";
import { api, segment } from "../api";
import { Icon } from "../icons";
import { Alert, Button, CardBody, Collapsible, confirmDialog, Feedback, Field, RelativeTime, ResourceState, Row, Section, Sheet, StatusBadge, useAction,
  useResource } from "../ui";

/*
 * A host's extensions (docs/design/host-extensions.md): what it has installed and what each offers, ignores or does
 * nothing with; the extensions its workspaces use that it lacks, which its owner installs here; and its owner's switch
 * that lets workspaces run extension tools without approval on it. Its connector carries out installs when it next
 * syncs, within half a minute while it is online.
 */

interface HostRequest { id: string; action: "install" | "remove"; source: string; status: "pending" | "done" | "failed"; error?: string; requestedAt: string; finishedAt?: string }
interface HostExtensionsResponse {
  role: "owner" | "admin";
  report?: HostExtensionsReport; reportedAt?: string;
  automaticTools: boolean;
  requests: HostRequest[];
  workspaces: { id: string; name: string; shared: boolean; extensions: { source: string; availability: ExtensionAvailability }[] }[];
}

const info = <div className="stack">
  <p>Pi extensions this host runs for the sessions on it: those a workspace chose that it has installed at the same version. They run in its connector, as your OS user, outside the sandbox.</p>
  <p>Install what your workspaces use here, or on the host with <code>pikibun extensions add</code>. A dev extension, installed there from a local path, runs only in your own sessions on this host.</p>
  <p>Extension tool calls need the approval of you or a member granted host commands, unless a workspace sets an extension's tools to automatic and you let workspaces do that here.</p>
</div>;

function ModuleDetails({ extension }: { extension: InstalledExtension }) {
  if (extension.error) return <Row title="Doesn't load" hint={extension.error} trailing={<StatusBadge tone="danger">Error</StatusBadge>} />;
  return <>{extension.modules.map(module => <CardBody key={module.path}>
    <div className="stack small">
      <strong><code>{module.path}</code></strong>
      {module.error && <span>Doesn't load: {module.error}</span>}
      {!!module.tools.length && <span>Tools: {module.tools.map(tool => tool.name).join(", ")}</span>}
      {!!module.events.length && <span className="muted">Events: {module.events.join(", ")}</span>}
      {!!module.flags.length && <span className="muted">Settings: {module.flags.map(flag => flag.name).join(", ")}</span>}
      {!!module.noops.length && <span className="muted">Does nothing in Pikibun: {module.noops.join(", ")}</span>}
      {!!module.ignored.length && <span className="muted">Not supported: {module.ignored.join(", ")}</span>}
    </div>
  </CardBody>)}</>;
}

export function HostExtensionsSection({ connector }: { connector: ConnectorInfo }) {
  const path = `/api/connectors/${segment(connector.id)}/extensions`;
  const resource = useResource<HostExtensionsResponse>(path);
  const action = useAction();
  const [installing, setInstalling] = useState(false);
  const data = resource.data;
  const owner = data?.role === "owner";
  const pending = data?.requests.filter(request => request.status === "pending") ?? [];
  // While requests wait for the host, look again every few seconds.
  useEffect(() => {
    if (!pending.length) return;
    const timer = setInterval(resource.refresh, 5000);
    return () => clearInterval(timer);
  }, [pending.length, resource.refresh]);

  async function request(requestAction: "install" | "remove", source: string): Promise<boolean> {
    let done = false;
    await action.run(async () => {
      await api(`${path}/requests`, { method: "POST", body: { action: requestAction, source } });
      done = true;
      resource.refresh();
    }, connector.online ? "Asked the host: it carries this out within half a minute." : "Asked the host: it carries this out once it is online.");
    return done;
  }
  function remove(source: string) {
    void (async () => {
      if (!await confirmDialog({ title: "Remove this extension from the host?", message: <>Sessions on this host stop running <code>{source}</code> once it is removed, in every workspace that uses it.</>, confirmLabel: "Remove", destructive: true })) return;
      await request("remove", source);
    })();
  }
  function setAutomatic(automaticTools: boolean) {
    void action.run(async () => {
      await api(path, { method: "PATCH", body: { automaticTools } });
      resource.refresh();
    }, automaticTools ? "Workspaces may now run extension tools without approval on this host, where they set them to automatic." : "Extension tools on this host need approval again.");
  }
  const missing = (data?.workspaces ?? []).flatMap(workspace => workspace.extensions.filter(item => item.availability.status !== "installed").map(item => ({ workspace, ...item })));
  const waiting = (source: string) => pending.some(item => item.source === source);
  return <Section title="Extensions" bare info={info} action={owner && data?.report?.remoteInstalls !== false
    ? <Button variant="outline" size="sm" icon="plus" disabled={!!connector.revokedAt} onClick={() => setInstalling(true)}>Install extension</Button> : undefined}>
    <ResourceState loading={resource.loading && !data} error={resource.error} retry={resource.refresh}>
      {data && <div className="card">
        {!connector.capabilities.extensions && <Row title="Update the host's connector" hint="This host's connector predates extensions: its sessions run none until it is updated (npx pikibun@latest connect)." />}
        {connector.capabilities.extensions && !data.report && <Row title="Not reported yet" hint="The host reports its extensions once its connector is online" />}
        {data.report && !data.report.remoteInstalls && <Row title="Installs from Pikibun are off" hint="Its connector runs with --no-remote-installs: install extensions on the host with pikibun extensions" />}
        {data.report && !data.report.installed.length && <Row title="No extensions installed" hint="Install those your workspaces use, below" />}
        {data.report?.installed.map(extension => <Collapsible key={extension.source} leading={<Icon name="tool" size={16} />} title={<code>{extension.source}</code>}
          hint={extension.dev ? "Dev extension: your own sessions on this host" : extension.description ?? `${extension.modules.flatMap(module => module.tools).length} tools`}
          trailing={extension.error || extension.modules.some(module => module.error) ? <StatusBadge tone="danger">Error</StatusBadge>
            : extension.dev ? <StatusBadge tone="warning">Dev</StatusBadge> : waiting(extension.source) ? <StatusBadge tone="neutral" dot>Removing</StatusBadge> : <StatusBadge tone="success">Installed</StatusBadge>}>
          <ModuleDetails extension={extension} />
          {owner && !extension.dev && data.report?.remoteInstalls && <CardBody><div className="inline"><span className="spacer" />
            <Button variant="ghost" size="sm" icon="trash" disabled={action.busy || waiting(extension.source)} onClick={() => remove(extension.source)}>Remove</Button>
          </div></CardBody>}
        </Collapsible>)}
        {missing.map(item => <Row key={`${item.workspace.id} ${item.source}`} leading={<Icon name="alert" size={16} />} title={<code>{item.source}</code>}
          hint={`${item.workspace.name} uses it${item.availability.status === "other-version" ? `; this host has ${item.availability.installed}` : "; this host doesn't have it"}. Its sessions here run without it`}
          trailing={waiting(item.source) ? <StatusBadge tone="neutral" dot>Installing</StatusBadge>
            : owner && data.report?.remoteInstalls !== false ? <Button variant="outline" size="sm" disabled={action.busy || !!connector.revokedAt}
              onClick={() => void request("install", item.source)}>{item.availability.status === "other-version" ? "Update" : "Install"}</Button>
            : <StatusBadge tone="neutral">Missing</StatusBadge>} />)}
        {owner && <Row title="Let workspaces run extension tools without approval" hint="Only where a workspace sets an extension's tools to automatic. Off: each call waits for you, or a member granted host commands"
          trailing={<input type="checkbox" className="checkbox" aria-label="Let workspaces run extension tools without approval" checked={data.automaticTools} disabled={action.busy}
            onChange={event => setAutomatic(event.target.checked)} />} />}
        {!owner && <Row title="Extension tools without approval" trailing={<StatusBadge tone={data.automaticTools ? "warning" : "neutral"}>{data.automaticTools ? "Allowed" : "Off"}</StatusBadge>} />}
        {!!data.requests.length && <Collapsible title="Recent requests" hint={pending.length ? `${pending.length} waiting for the host` : "Installs and removals asked for here"}>
          {data.requests.map(item => <Row key={item.id} title={<><span className="muted">{item.action === "install" ? "Install" : "Remove"}</span> <code>{item.source}</code></>}
            hint={item.error ?? <RelativeTime value={item.finishedAt ?? item.requestedAt} />}
            trailing={<StatusBadge tone={item.status === "done" ? "success" : item.status === "failed" ? "danger" : "neutral"} dot={item.status === "pending"}>
              {item.status === "pending" ? "Waiting" : item.status === "done" ? "Done" : "Failed"}</StatusBadge>} />)}
        </Collapsible>}
        {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
      </div>}
    </ResourceState>
    {installing && <InstallSheet close={() => setInstalling(false)} busy={action.busy} error={action.error}
      install={async source => { if (await request("install", source)) setInstalling(false); }} />}
  </Section>;
}

function InstallSheet({ close, install, busy, error }: { close: () => void; install: (source: string) => Promise<void>; busy: boolean; error: string }) {
  const [source, setSource] = useState("");
  let normalized: string | undefined;
  let invalid = "";
  try { normalized = source.trim() ? normalizeExtensionSource(source.trim()) : undefined; }
  catch (reason) { invalid = reason instanceof Error ? reason.message : "Invalid source"; }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (normalized) void install(normalized);
  }
  return <Sheet open title="Install extension" onClose={() => { if (!busy) close(); }} footer={<>
    <Button disabled={busy} onClick={close}>Cancel</Button>
    <Button variant="default" type="submit" form="install-extension-form" disabled={busy || !normalized}>{busy ? "Asking..." : "Install"}</Button>
  </>}>
    <form id="install-extension-form" className="stack" onSubmit={submit}>
      <Alert variant="warning" title="Runs on your machine">An extension runs in this host's connector, as your OS user, with your files, credentials and network. Install only code you trust. npm runs none of its install scripts.</Alert>
      <Field label="Source" hint="npm:<package>@<exact version>, or git:<https URL>@<full commit>" error={invalid}>
        <input className="input mono" value={source} onChange={event => setSource(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} maxLength={512}
          placeholder="npm:cc-safety-net@2.7.2" autoFocus />
      </Field>
      <Feedback error={error} />
    </form>
  </Sheet>;
}
