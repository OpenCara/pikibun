import { Scroll, signal } from "nsh";
import { Input } from "nsh/base";
import { segment, type SessionRecord } from "../shared";
import { session } from "../lib/auth";
import { createAction } from "../lib/resource";
import { palette } from "../theme";
import { Button, Feedback, Small } from "../ui";

export function OpenSession(props: { onOpen: (id: string) => void }) {
  const sessionId = signal("");
  const action = createAction();
  function open() {
    const id = sessionId().trim();
    if (!id || action.busy()) return;
    void action.run(async () => {
      // Checks access before leaving, so a wrong ID is explained here.
      const result = await session().api<{ session: SessionRecord }>(`/api/sessions/${segment(id)}`);
      props.onOpen(result.session.id);
    });
  }
  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ gap: 12, padding: 20, width: "100%", maxWidth: 560, alignSelf: "center" }}>
      <Small>Session ID — ask the session owner for its ID</Small>
      <Input testID="open-session-id" value={sessionId()} onChange={event => sessionId.set(event.value)} autoFocus autoCapitalize="none" autoCorrect={false}
        returnKeyType="go" onSubmit={open} accessibilityLabel="Session ID"
        style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, backgroundColor: palette().surface, borderColor: palette().border, color: palette().text }} />
      <Feedback error={action.error()} />
      <Button testID="open-session-submit" variant="primary" label={action.busy() ? "Checking access..." : "Open session"} disabled={action.busy() || !sessionId().trim()} onPress={open} />
    </Scroll>
  );
}
