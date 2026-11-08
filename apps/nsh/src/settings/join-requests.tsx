import { effect, signal } from "nsh";
import type { OwnJoinRequest } from "../../../../packages/shared/src/invites";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Banner, Button, CardBody, confirm, Feedback, Row, Section, Small } from "../ui";
import { relativeTime } from "../lib/format";

/**
 * The signed-in person's own requests to join (JoinWorkspaceScreen.tsx's OwnJoinRequests), each with Withdraw. They
 * don't need the link they came through, which may have been turned off or replaced since. Nothing while there are none.
 */
export function OwnJoinRequests() {
  const resource = createResource<{ requests: OwnJoinRequest[] }>(() => "/api/join-requests");
  const action = createAction();
  const requests = () => resource.data()?.requests ?? [];
  // Once a load fails, the section stays until one succeeds, so Try again doesn't make it vanish while it retries.
  const failed = signal(false);
  effect(() => {
    if (resource.error()) failed.set(true);
    else if (resource.data()) failed.set(false);
  });
  async function withdraw(request: OwnJoinRequest) {
    if (action.busy()) return;
    if (!await confirm({ title: "Withdraw request", destructive: true, confirmLabel: "Withdraw",
      message: `Stop waiting to join ${request.workspaceName}? You can ask again while you have a working invite link.` })) return;
    void action.run(async () => {
      await session().api(`/api/join-requests/${segment(request.workspaceId)}`, { method: "DELETE" });
      resource.refresh();
    }, "Request withdrawn.");
  }
  return (
    <If when={requests().length > 0 || action.notice() || failed()}>
      <Section title="Your requests to join" testID="own-join-requests" info="Workspaces you asked to join through an invite link. An owner or admin of each accepts or declines you.">
        <If when={!(failed() && !requests().length)}
          else={<CardBody><Banner tone="danger" title="Could not load your requests"
            actions={<Button small variant="outline" label={resource.loading() ? "Trying…" : "Try again"} disabled={resource.loading()} onPress={resource.refresh} />}>
            {resource.error() || "Your requests could not be loaded."}</Banner></CardBody>}>
          <If when={requests().length > 0} else={<CardBody><Small>You aren't waiting to join any workspace</Small></CardBody>}>
            <Each of={requests()} key={request => request.workspaceId}>
              {request => (
                <Row title={request().workspaceName} hint={`Waiting for approval · asked ${relativeTime(request().createdAt)}`}
                  trailing={<Button small variant="outline" label="Withdraw" disabled={action.busy()} onPress={() => void withdraw(request())} />} />
              )}
            </Each>
          </If>
        </If>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
    </If>
  );
}
