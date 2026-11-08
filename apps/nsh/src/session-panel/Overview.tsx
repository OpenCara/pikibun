import { Clipboard, untracked } from "nsh";
import { segment, sessionStatus, type ConnectorInfo } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createUsername } from "../lib/people";
import { createAction, createResource } from "../lib/resource";
import { timestamp } from "../lib/format";
import { Badge, Banner, Button, CardBody, Feedback, Row, Section, Small } from "../ui";
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
            <If when={current().hostUnsandboxed}>
              <Banner tone="danger" title="Unsandboxed host">This session's host runs without a sandbox.</Banner>
            </If>
            <Section title="Session">
              <Row title={current().title} trailing={status()?.label ? <Badge tone={status()!.tone} dot>{status()!.label!}</Badge> : undefined} />
              <Row title="Workspace" trailing={workspace()?.name ?? current().workspaceId} />
              <Row title="Owner" trailing={name(current().ownerId, true)} />
              <Row title="Host" hintTestID="session-people" hint={current().connectorId
                ? `${host()?.name ?? "Pinned host"}, hosted by ${hostOwner()}${current().connectorOwnerId === user.id ? " (you)" : ""}${host() && !host()!.online ? " · offline" : ""}`
                : "Operator-managed session"} />
              <Row title="Visibility" hint={`${current().visibility === "workspace" ? "Workspace members can view it" : "Private: only people given a role, and the workspace's owner and admins"}${current().linkShared ? " · A share link is on" : ""}`} />
              <Row title="Started" trailing={timestamp(current().createdAt)} />
            </Section>
            <Section title="Open elsewhere">
              <Row title="Session ID" hint={props.sessionId} selectableHint
                trailing={<Button small variant="ghost" icon="copy" label="Copy" onPress={() => void action.run(() => Clipboard.writeText(props.sessionId), "Session ID copied")} />} />
              <CardBody><Small>Open it on another device with Open a session by ID.</Small></CardBody>
            </Section>
            <Feedback error={action.error()} notice={action.notice()} />
          </>
        )}
      </If>
    </TabPage>
  );
}
