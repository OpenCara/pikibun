import { untracked } from "nsh";
import { installChatMessage, installChatTitle } from "../../../../packages/shared/src/program-install";
import { chatOptionsBody, preferredSelection, segment, type ConnectorInfo, type ModelDefinition, type SessionRecord } from "../shared";
import { Button } from "../ui";
import { useAppData } from "./app-data";
import { session } from "./auth";
import { randomId } from "./format";
import type { PageRoute } from "./page";
import type { Action } from "./resource";

export type MissingPrograms = Readonly<Record<string, readonly string[]>>;

export function installChatUnavailable(host: ConnectorInfo | undefined, userId: string): string | undefined {
  if (!host) return "The host isn't in your list";
  if (host.ownerId !== userId) return "Only the host's owner installs programs on it";
  if (host.revokedAt) return "The host was revoked";
  if (!host.online) return "The host is offline";
  if (!host.models.length) return "The host offers no model";
  return undefined;
}

export function createInstallChat(go: (route: PageRoute) => void) {
  const data = useAppData();
  return async (host: ConnectorInfo, missing: MissingPrograms): Promise<void> => {
    const { api, user } = untracked(session);
    if (!data.workspaces().some(item => item.personal)) await data.refreshWorkspaces();
    const workspace = data.workspaces().find(item => item.personal && item.ownerId === user.id);
    if (!workspace) throw new Error("Your private workspace isn't available. Reload Pikibun and try again.");
    const { models } = await api<{ models: ModelDefinition[] }>(`/api/workspaces/${segment(workspace.id)}/models`);
    const offered = models.filter(item => item.connectorId === host.id && host.models.some(model => model.provider === item.provider && model.modelId === item.modelId));
    const usable = (wanted: { provider: string; modelId: string }) => offered.some(item => item.provider === wanted.provider && item.modelId === wanted.modelId);
    const remembered = data.lastChat()?.connectorId === host.id ? data.lastChat() : undefined;
    const selection = preferredSelection(host, remembered, offered[0], usable);
    const model = offered.find(item => item.provider === selection.model?.provider && item.modelId === selection.model?.modelId) ?? offered[0];
    if (!model) throw new Error(`${host.name} offers no model in your private workspace.`);
    const onHost = Boolean(host.hostSessions);
    const chat = { host: host.name, missing, onHost };
    const options = chatOptionsBody(host, selection, "submit");
    const created = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: {
      workspaceId: workspace.id, modelId: model.id, title: installChatTitle(chat), visibility: "private", ...(onHost ? { hostEnvironment: true } : {}),
    } });
    const sessionId = created.session.id;
    await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: {
      content: installChatMessage(chat), requestId: randomId(), ...(options ? { options } : {}),
    } });
    void data.refreshSessions();
    go({ name: "session", sessionId });
  };
}

export function InstallChatButton(props: { host: ConnectorInfo | undefined; missing: MissingPrograms; action: Action; go: (route: PageRoute) => void; testID?: string }) {
  const { user } = untracked(session);
  const start = createInstallChat(route => props.go(route));
  const unavailable = () => installChatUnavailable(props.host, user.id);
  return (
    <If when={props.host?.ownerId === user.id}>
      <Button small variant="outline" icon="message" label="Chat" testID={props.testID ?? "install-chat"} disabled={Boolean(unavailable()) || props.action.busy()}
        onPress={() => { const host = props.host; if (host && !unavailable()) void props.action.run(() => start(host, props.missing)); }} />
    </If>
  );
}
