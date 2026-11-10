import { effect, Scroll, signal, Text, View } from "nsh";
import type { WorkspaceInvite } from "../../../../packages/shared/src/invites";
import { errorMessage } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import type { PageRoute } from "../lib/page";
import { createAction } from "../lib/resource";
import { palette, text, weight } from "../theme";
import { Banner, Button, Feedback, Loading, Logo } from "../ui";
import { OwnJoinRequests } from "../settings/join-requests";

export function JoinWorkspace(props: { token: string; onDone: () => void; go?: (route: PageRoute) => void }) {
  const data = useAppData();
  const invite = signal<WorkspaceInvite | null>(null);
  const loading = signal(true);
  const error = signal("");
  const revision = signal(0);
  const action = createAction();
  effect(() => {
    revision();
    const controller = new AbortController();
    loading.set(true);
    error.set("");
    session().api<{ invite: WorkspaceInvite }>("/api/invite", { headers: { "x-invite-token": props.token }, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) invite.set(result.invite); })
      .catch(reason => { if (!controller.signal.aborted) { invite.set(null); error.set(errorMessage(reason)); } })
      .finally(() => { if (!controller.signal.aborted) loading.set(false); });
    return () => controller.abort();
  });
  effect(() => { if (invite()?.status === "member") data.refreshWorkspaces(); });
  const refresh = () => revision.update(value => value + 1);
  function ask() {
    if (action.busy()) return;
    void action.run(async () => {
      invite.set((await session().api<{ invite: WorkspaceInvite }>("/api/invite", { method: "POST", body: { token: props.token } })).invite);
    });
  }
  function withdraw() {
    if (action.busy()) return;
    void action.run(async () => {
      invite.set((await session().api<{ invite: WorkspaceInvite }>("/api/invite", { method: "DELETE", headers: { "x-invite-token": props.token } })).invite);
    }, "Request withdrawn.");
  }
  const heading = (value: string) => <Text role="header" style={{ fontSize: text.heading, fontWeight: weight.light, textAlign: "center", color: palette().text }}>{value}</Text>;
  const paragraph = (value: string) => <Text style={{ fontSize: text.body, lineHeight: 21, textAlign: "center", color: palette().muted }}>{value}</Text>;
  return (
    <View testID="join-workspace" style={{ flex: 1, backgroundColor: palette().background }}>
      <If when={!(loading() && !invite())} else={<Loading />}>
        <Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", paddingVertical: 40, paddingHorizontal: 24 }}>
          <View style={{ width: "100%", maxWidth: 420, alignItems: "stretch", gap: 20 }}>
            <View style={{ alignItems: "center" }}><Logo size={40} /></View>
            <If when={invite()}
              else={
                <>
                  {heading("Join a workspace")}
                  <Banner tone="danger" title="Invite link not available" actions={<Button small variant="outline" label="Try again" onPress={refresh} />}>{error()}</Banner>
                  <Button block label="Go to Pikibun" onPress={props.onDone} />
                  <OwnJoinRequests />
                </>
              }>
              {current => (
                <>
                  {heading(current().workspaceName)}
                  <If when={current().status === "none"}>
                    {paragraph("You're invited to join this workspace. Ask to join, and an owner or admin reviews your request and chooses your role. Until they accept you, you can't see or do anything in it.")}
                    <Button testID="join-ask" block large variant="primary" label={action.busy() ? "Asking…" : "Ask to join"} disabled={action.busy()} onPress={ask} />
                  </If>
                  <If when={current().status === "pending"}>
                    <Banner tone="info" title="Waiting for approval">{`Your request to join was sent. Once an owner or admin of ${current().workspaceName} accepts you, the workspace appears in your sidebar.`}</Banner>
                    <Button block label="Check again" disabled={action.busy() || loading()} onPress={refresh} />
                    <Button block variant="ghost" label="Withdraw request" disabled={action.busy()} onPress={withdraw} />
                  </If>
                  <If when={current().status === "member"}>
                    <Banner tone="success" title="You're a member">{`You're a member of ${current().workspaceName}.`}</Banner>
                    <Button testID="join-open" block variant="primary" label="Open workspace"
                      onPress={() => (current().workspaceId && props.go ? props.go({ name: "settings", section: "workspaces", id: current().workspaceId! }) : props.onDone())} />
                  </If>
                  <Feedback error={action.error()} notice={action.notice()} />
                </>
              )}
            </If>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
