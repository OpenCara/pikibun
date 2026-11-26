import { View } from "nsh";
import type { McpConnection, McpConnectionShare } from "../../../../packages/shared/src/remote-mcp";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { CheckControl } from "../form";
import { Badge, Button, confirm, EmptyState, Feedback, Note, ResourceState, Row, Section } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

const sharesOf = (connection: McpConnection): McpConnectionShare[] => connection.shares ?? [];

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function shareHint(share: McpConnectionShare): string {
  if (share.shared) return `Shared: every member's sessions here offer its tools${share.server ? ` (${share.server.prefix}_*)` : ""} and call them with your account`;
  return share.unavailable ?? "Not shared";
}

function About() {
  return (
    <View style={{ gap: 8 }}>
      <Note>Sharing one of your remote MCP servers with a workspace adds it to that workspace: every member's sessions there offer its tools and call them with your own account, whoever asks. What they do with it is done as you, and may spend what your account pays for.</Note>
      <Note>Its sign-in stays yours, kept encrypted, never shown to anyone. The workspace's owners and admins choose which of its tools only read, and can turn it off or remove it, but can't change its address or sign-in.</Note>
      <Note>Sharing stops at once when you turn it off here, remove the connection from your profile, or leave the workspace. Only the workspaces you own or administer are listed.</Note>
    </View>
  );
}

export function McpSharing(props: SectionProps) {
  const resource = createResource<{ connections: McpConnection[] }>(() => "/api/mcp-connections");
  const action = createAction();
  const connections = () => resource.data()?.connections ?? [];
  const anywhere = () => connections().some(connection => sharesOf(connection).length > 0);
  const path = (connection: McpConnection, share: McpConnectionShare) => `/api/mcp-connections/${segment(connection.id)}/shares/${segment(share.id)}`;
  async function toggle(connection: McpConnection, share: McpConnectionShare, on: boolean) {
    if (on && !await confirm({
      title: `Share ${connection.name} with ${share.name}?`, confirmLabel: "Share",
      message: `Every member of ${share.name} can then use its tools in their sessions with your account on ${hostOf(connection.url)}: what they do with it is done as you. Pikibun never shows them its sign-in, and you can stop sharing it here at any time.`,
    })) return;
    if (await action.run(async () => { await session().api(path(connection, share), { method: on ? "PUT" : "DELETE" }); },
      on ? `${share.name} offers ${connection.name}'s tools to every member from their next message.` : `${share.name} no longer uses ${connection.name}.`)) resource.refresh();
  }
  return (
    <SectionPage testID="settings-mcp-sharing">
      <ResourceState loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={connections().length}
          else={
            <Section title="Share remote MCP servers" info={<About />}>
              <EmptyState title="No remote MCP servers connected"
                action={<Button small variant="outline" label="Open profile" testID="mcp-sharing-open-profile" onPress={() => props.go({ name: "settings", section: "profile" })} />}>
                Connect your own account on a remote MCP server in your profile, under Connected accounts, then share it here.
              </EmptyState>
            </Section>
          }>
          <If when={action.error() || action.notice()}><Feedback error={action.error()} notice={action.notice()} /></If>
          <If when={!anywhere()}>
            <Section title="Share remote MCP servers" info={<About />}>
              <Row title="No workspace to share with" hint="You share your remote MCP servers with the workspaces you own or administer, and you own or administer none" />
            </Section>
          </If>
          <Each of={connections()} key={connection => connection.id}>
            {connection => (
              <Section testID={`mcp-sharing-${connection().id}`} title={`${connection().name} · ${hostOf(connection().url)}`} info={<About />}
                action={connection().error ? <Badge tone="danger">Error</Badge> : undefined}>
                <If when={connection().error}>
                  <Row title="Its sign-in needs attention" hint={`${connection().error!}\nFix it in your profile: the workspaces it's shared with can't use it meanwhile.`} />
                </If>
                <If when={sharesOf(connection()).length} else={<Row title="No workspace to share with" hint="Only the workspaces you own or administer are listed" />}>
                  <Each of={sharesOf(connection())} key={share => share.id}>
                    {share => (
                      <Row testID={`mcp-share-${connection().id}-${share().id}`} title={share().name} hint={shareHint(share())}
                        trailing={<CheckControl testID={`mcp-share-toggle-${connection().id}-${share().id}`} label={`Share ${connection().name} with ${share().name}`}
                          checked={share().shared} disabled={action.busy() || (!share().shared && !!share().unavailable)}
                          onChange={on => void toggle(connection(), share(), on)} />} />
                    )}
                  </Each>
                </If>
              </Section>
            )}
          </Each>
        </If>
      </ResourceState>
    </SectionPage>
  );
}
