import { Text, View } from "nsh";
import { repositoryProgressText, repositoryProgressValue, segment } from "../shared";
import type { RepositoryPreparationView } from "../../../../packages/shared/src/types";
import { session } from "../lib/auth";
import { createAction } from "../lib/resource";
import { monospace, palette } from "../theme";
import { Banner, Button, Card, Feedback, Small } from "../ui";

/**
 * A cache host preparing this session's repositories: one bar per repository while it clones or fetches, checks and
 * checks out. If that failed, its reason, and for the owner a way to try again.
 */
export function RepositoryPreparationCard(props: { sessionId: string; preparation: RepositoryPreparationView; canRestart: boolean; onRestarted: () => void }) {
  const action = createAction();
  const restart = () => void action.run(async () => {
    await session().api(`/api/sessions/${segment(props.sessionId)}/restart`, { method: "POST" });
    props.onRestarted();
  });
  return (
    <If when={props.preparation.status === "failed"}
      else={
        <Card testID="repository-preparation">
          <Text role="header" style={{ fontSize: 14, fontWeight: "500", color: palette().text }}>Preparing repositories…</Text>
          <Each of={props.preparation.items} key={item => item.path}>
            {item => (
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2 }}>
                  <Text style={{ numberOfLines: 1, flexShrink: 1, fontFamily: monospace, fontSize: 13, color: palette().text }}>{item().path}</Text>
                  <Small>{repositoryProgressText(item())}</Small>
                </View>
                <View role="progressbar" accessibilityLabel={`${item().path}: ${repositoryProgressText(item())}`}
                  style={{ height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: palette().code }}>
                  <View style={{ height: "100%", borderRadius: 3, width: `${repositoryProgressValue(item()) ?? 30}%`, backgroundColor: palette().tones.running.text }} />
                </View>
              </View>
            )}
          </Each>
          <Small>The first session on a host clones each repository with its full history; later sessions fetch only what changed. Messages sent now run when this is done.</Small>
        </Card>
      }>
      <Banner tone="danger" title="Repositories could not be prepared"
        actions={<If when={props.canRestart}><Button small variant="outline" label={action.busy() ? "Restarting..." : "Restart session"} disabled={action.busy()} onPress={restart} /></If>}>
        {`${props.preparation.error ?? "The host could not prepare this session's repositories."} ${props.canRestart
          ? "Fix the cause on the host, then restart the session. Queued messages run once the repositories are ready."
          : "The session owner can restart the session once the cause is fixed."}`}
      </Banner>
      <Feedback error={action.error()} />
    </If>
  );
}
