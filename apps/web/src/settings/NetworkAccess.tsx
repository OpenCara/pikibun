import { useEffect, useState, type FormEvent } from "react";
import type { Workspace } from "../../../../packages/shared/src/types";
import { networkLimits, type NetworkMode, type NetworkPolicy } from "../../../../packages/shared/src/network";
import { webSearchKeyLength, webSearchProviderKeyPages, webSearchProviderNames, workspaceWebSearchProviders,
  type WorkspaceWebSearch, type WorkspaceWebSearchProvider } from "../../../../packages/shared/src/web";
import { api, segment } from "../api";
import { Button, CardBody, Feedback, Field, ResourceState, Row, Section, SegmentedControl, Sheet, StatusBadge, useAction, useResource } from "../ui";

interface NetworkPolicyResponse {
  policy: NetworkPolicy; packageRegistryDomains: string[];
  /** The workspace's search provider for web_search, its own or else the server's; null (or absent, from an older server) when it has none. */
  webSearchProvider?: string | null;
}

const providerLabel: Record<string, string> = webSearchProviderNames;

const modeLabel: Record<NetworkMode, string> = { off: "Off", allowlist: "Allowlist", open: "Open" };
const modeHint: Record<NetworkMode, string> = {
  off: "Sandboxed commands reach only this workspace's repositories",
  allowlist: "The workspace's repositories, plus the domains below",
  open: "The workspace's repositories, plus any public host",
};

/** What sandboxed sessions may reach through their host's egress proxy, besides the workspace's repositories. */
export function NetworkAccess({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/network-policy`;
  const resource = useResource<NetworkPolicyResponse>(path);
  const action = useAction();
  const [mode, setMode] = useState<NetworkMode>("off");
  const [domains, setDomains] = useState("");
  const [registries, setRegistries] = useState(true);
  const [webSearch, setWebSearch] = useState(false);
  const saved = resource.data?.policy;
  useEffect(() => {
    if (!saved) return;
    setMode(saved.mode);
    setDomains(saved.domains.join("\n"));
    setRegistries(saved.packageRegistries);
    setWebSearch(saved.webSearch === true);
  }, [saved]);
  const list = domains.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean);
  const changed = !!saved && (mode !== saved.mode || registries !== saved.packageRegistries || webSearch !== (saved.webSearch === true)
    || list.join("\n") !== saved.domains.join("\n"));
  const provider = resource.data?.webSearchProvider;
  function save() {
    if (!admin || action.busy) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { mode, domains: list, packageRegistries: registries, webSearch } });
      resource.refresh();
    }, "Network access saved. Running sessions pick it up within a minute.");
  }
  return <Section title="Network access" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change network access.</p>}
    <p>Sandboxed shell commands have no direct network. Everything goes through the host's egress proxy: Git reads of this workspace's repositories always work, with the session owner's own account, which never leaves Pikibun.</p>
    <p>This setting decides what else is reachable over HTTPS. Addresses inside the host's own networks are never reachable. Hosts running without the sandbox aren't confined by it.</p>
    <p>The agent's <code>web_fetch</code> tool reads web pages from the host as far as this reaches, on every host. <code>web_search</code> searches with the search provider chosen below (or else the server's), only where web search is on: each query leaves for that provider.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {saved && <>
        <Row title="Access" hint={modeHint[mode]} trailing={admin
          ? <SegmentedControl label="Network access" value={mode} onChange={setMode} options={(["off", "allowlist", "open"] as const).map(value => ({ value, label: modeLabel[value] }))} />
          : <StatusBadge tone={saved.mode === "off" ? "neutral" : "success"}>{modeLabel[saved.mode]}</StatusBadge>} />
        {mode === "allowlist" && <CardBody>
          <div className="stack">
            <Field label="Allowed domains" hint={`One per line, up to ${networkLimits.domains}. *.example.com allows its subdomains.`}>
              <textarea className="textarea mono" rows={4} disabled={!admin} value={domains} onChange={event => setDomains(event.target.value)} autoComplete="off" spellCheck={false} placeholder="docs.example.com" />
            </Field>
            <label className="check-row small" title={resource.data!.packageRegistryDomains.join(", ")}><input type="checkbox" className="checkbox" checked={registries} disabled={!admin} onChange={event => setRegistries(event.target.checked)} /><span>Allow package registries (npm, PyPI, crates.io, Go, RubyGems, Maven, NuGet, Packagist)</span></label>
          </div>
        </CardBody>}
        <Row title="Web search" hint={provider
          ? `Agents search the web with web_search, through ${providerLabel[provider] ?? provider}. Their queries go to it.`
          : "Choose a search provider below first."} trailing={admin
          ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={webSearch} disabled={!provider && !webSearch}
            onChange={event => setWebSearch(event.target.checked)} /><span>Allow web search</span></label>
          : <StatusBadge tone={saved.webSearch && provider ? "success" : "neutral"}>{saved.webSearch && provider ? "On" : "Off"}</StatusBadge>} />
        <WebSearchProvider workspace={workspace} admin={admin} changed={resource.refresh} />
        {admin && (changed || action.error || action.notice) && <CardBody>
          <div className="stack">
            <Feedback {...action} />
            {changed && <div><Button variant="default" size="sm" disabled={action.busy} onClick={save}>Save network access</Button></div>}
          </div>
        </CardBody>}
      </>}
    </ResourceState>
  </Section>;
}

/**
 * The workspace's search provider: one its owners and admins choose with their own API key, which stays on the server
 * and which no one sees again, or else the one the server's operator configured.
 */
function WebSearchProvider({ workspace, admin, changed }: { workspace: Workspace; admin: boolean; changed: () => void }) {
  const path = `/api/workspaces/${segment(workspace.id)}/web-search`;
  const resource = useResource<{ settings: WorkspaceWebSearch }>(path);
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<WorkspaceWebSearchProvider | "server">("brave");
  const [key, setKey] = useState("");
  const settings = resource.data?.settings;
  // A server that predates workspace providers has no such page: the row stays away, and the server's provider applies.
  if (!settings) return null;
  const server = settings.serverProvider;
  const current = settings.provider ? `${providerLabel[settings.provider]}, with this workspace's API key`
    : server ? `${providerLabel[server] ?? server}, the server's` : "None";
  function edit() {
    setChoice(settings!.provider ?? (server ? "server" : "brave")); setKey(""); setEditing(true);
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!admin || action.busy) return;
    void action.run(async () => {
      if (choice === "server") await api(path, { method: "DELETE" });
      else await api(path, { method: "PUT", body: { provider: choice, apiKey: key } });
      setEditing(false); setKey(""); resource.refresh(); changed();
    }, choice === "server" && !server ? "Search provider removed." : "Search provider saved. The next search uses it.");
  }
  const close = () => { if (!action.busy) { setEditing(false); setKey(""); } };
  return <>
    <Row title="Search provider" hint={current} trailing={admin
      ? <Button size="sm" onClick={edit}>{settings.provider || server ? "Change" : "Choose"}</Button> : undefined} />
    {admin && action.notice && !editing && <CardBody><Feedback notice={action.notice} /></CardBody>}
    <Sheet open={editing} title="Web search provider" onClose={close} footer={<>
      <Button disabled={action.busy} onClick={close}>Cancel</Button>
      <Button variant="default" type="submit" form="web-search-provider-form" disabled={action.busy || (choice !== "server" && !key.trim())}>Save</Button>
    </>}>
      <form id="web-search-provider-form" className="stack" onSubmit={save}>
        <p className="muted small">Every member's web searches go to this provider, with this key, and are billed to it.</p>
        <Field label="Provider" hint={choice === "server" ? (server ? "Searches use the provider this server's operator configured, and this workspace's key is deleted." : "This workspace's key is deleted, and agents can't search until a provider is chosen again.") : <>
          Get a key at <a href={webSearchProviderKeyPages[choice]} target="_blank" rel="noreferrer">{webSearchProviderKeyPages[choice].replace(/^https:\/\//, "")}</a>.</>}>
          <select className="select" value={choice} disabled={action.busy} onChange={event => setChoice(event.target.value as WorkspaceWebSearchProvider | "server")}>
            {(server || settings.provider) && <option value="server">{server ? `The server's: ${providerLabel[server] ?? server}` : "None: remove this workspace's key"}</option>}
            {workspaceWebSearchProviders.map(name => <option key={name} value={name}>{providerLabel[name]}</option>)}
          </select>
        </Field>
        {choice !== "server" && <Field label="API key" hint={settings.provider ? "Enter the key again to save; the saved one is never shown." : "Stored encrypted on the server; no one sees it again, not even admins."}>
          <input className="input mono" type="password" required value={key} maxLength={webSearchKeyLength} disabled={action.busy}
            onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>}
        <Feedback error={action.error} />
      </form>
    </Sheet>
  </>;
}
