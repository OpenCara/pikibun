import { Clipboard, Text, untracked, View } from "nsh";
import { segment, sessionStatus, type ConnectorInfo } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createUsername } from "../lib/people";
import { createAction, createResource } from "../lib/resource";
import { timestamp } from "../lib/format";
import { palette, text } from "../theme";
import { Badge, Button, Card, Feedback, Row, Small, Value } from "../ui";
import { TabPage, type PanelTabProps } from "./parts";

/**
 * The session's details: where it lives, who owns it, the host it runs on and who sees it, and its ID. Renaming,
 * repositories, the pull request, people and their roles, archiving, backups and moving it are still to come here.
 */
export function Overview(props: PanelTabProps) {
  const { user } = untracked(session);
  const data = useAppData();
  const name = createUsername();
  const action = createAction();
  const hosts = createResource<{ connectors: ConnectorInfo[] }>(() => {
    const current = props.session();
    return current?.connectorId ? `/api/workspaces/${segment(current.workspaceId)}/connectors` : null;
  });
  const host = () => hosts.data()?.connectors.find(item => item.id === props.session()?.connectorId);
  const workspace = () => data.workspaces().find(item => item.id === props.session()?.workspaceId);
  const status = () => {
    const current = props.session();
    return current ? sessionStatus(current, props.view()?.activity) : null;
  };
  const hostOwner = () => {
    const current = props.session();
    return host()?.ownerName ?? (current?.connectorOwnerId ? name(current.connectorOwnerId) : "unknown");
  };
  return (
    <TabPage testID="panel-overview">
      <If when={props.session()} else={<Small>Loading…</Small>}>
        {current => (
          <>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: palette().text }}>{current().title}</Text>
                <If when={status()?.label}>
                  <Badge tone={status()!.tone} dot>{status()!.label!}</Badge>
                </If>
              </View>
              <Row label="Workspace"><Value>{workspace()?.name ?? current().workspaceId}</Value></Row>
              <Row label="Owner"><Value>{name(current().ownerId, true)}</Value></Row>
              <Row label="Host">
                <Value testID="session-people">
                  {current().connectorId
                    ? `${host()?.name ?? "Pinned host"}, hosted by ${hostOwner()}${current().connectorOwnerId === user.id ? " (you)" : ""}${host() && !host()!.online ? " · offline" : ""}`
                    : "Operator-managed session"}
                </Value>
              </Row>
              <Row label="Visibility">
                <Value>{`${current().visibility === "workspace" ? "Workspace members can view it" : "Private: only people given a role, and the workspace's owner and admins"}${current().linkShared ? " · A share link is on" : ""}`}</Value>
              </Row>
              <If when={current().hostUnsandboxed}>
                <Small tone="danger">This session's host runs without a sandbox.</Small>
              </If>
              <Row label="Started"><Value>{timestamp(current().createdAt)}</Value></Row>
            </Card>
            <Card>
              <Row label="Session ID">
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <View selectable style={{ flexShrink: 1 }}>
                    <Text style={{ fontFamily: "monospace", fontSize: text.small, color: palette().text }}>{props.sessionId}</Text>
                  </View>
                  <Button small variant="ghost" icon="copy" label="Copy" onPress={() => void action.run(() => Clipboard.writeText(props.sessionId), "Session ID copied")} />
                </View>
              </Row>
              <Small>Open it on another device with Open a session by ID.</Small>
            </Card>
            <Feedback error={action.error()} notice={action.notice()} />
          </>
        )}
      </If>
    </TabPage>
  );
}
