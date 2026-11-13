import { signal, Text, View } from "nsh";
import type { SudoPromptView } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { session } from "../lib/auth";
import { createAction } from "../lib/resource";
import { TextField } from "../form";
import { Icon } from "../icons";
import { monospace, palette, radius, text, weight } from "../theme";
import { Button, Feedback, Small } from "../ui";

export function SudoPrompt(props: { sessionId: string; prompt: SudoPromptView; hostName?: string; canAnswer: boolean; privateWorkspace: boolean }) {
  const password = signal("");
  const action = createAction();
  const tone = () => palette().tones.warning;
  const answers = () => props.canAnswer && props.privateWorkspace;
  function answer(decline: boolean) {
    const typed = password();
    if (action.busy() || (!decline && !typed)) return;
    password.set("");
    void action.run(async () => {
      await session().api(`/api/sessions/${segment(props.sessionId)}/sudo`, { method: "POST",
        body: decline ? { id: props.prompt.id, decline: true } : { id: props.prompt.id, password: typed } });
    });
  }
  return (
    <View testID="sudo-prompt" role="alert" style={{ gap: 8, padding: 12, borderRadius: radius.large, borderWidth: 1, borderColor: tone().text, backgroundColor: tone().background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="lock" size={16} color={tone().text} />
        <Text style={{ flex: 1, fontSize: text.body, fontWeight: weight.medium, color: palette().text }}>
          {`sudo asks for ${props.canAnswer ? "your" : "the host owner's"} password${props.hostName ? ` on ${props.hostName}` : ""}`}
        </Text>
      </View>
      <If when={props.prompt.command}>
        {command => (
          <View selectable style={{ borderRadius: radius.medium, backgroundColor: palette().code, paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text testID="sudo-command" style={{ fontFamily: monospace, fontSize: text.small, color: palette().text }}>{command()}</Text>
          </View>
        )}
      </If>
      <If when={answers()}
        else={<Small>{props.canAnswer ? "sudo takes a password only in sessions of your private workspace. Decline it here, and run the command in a terminal instead."
          : "Waiting for the host's owner to answer it. Only they can, and only in their own sessions."}</Small>}>
        <TextField testID="sudo-password" masked autoFocus value={password()} onChange={value => password.set(value)} onSubmit={() => answer(false)}
          placeholder={props.prompt.prompt} accessibilityLabel={props.prompt.prompt} autoCapitalize="none" autoCorrect={false} maxLength={1024} disabled={action.busy()} />
        <Small>It goes to this one sudo command on the host and nowhere else: not into the chat, the transcript or the agent's context, and nothing keeps it.</Small>
      </If>
      <If when={props.canAnswer}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button small variant="ghost" label="Decline" testID="sudo-decline" disabled={action.busy()} onPress={() => answer(true)} />
          <If when={answers()}>
            <Button small variant="primary" label="Send to sudo" testID="sudo-send" disabled={action.busy() || !password()} onPress={() => answer(false)} />
          </If>
        </View>
      </If>
      <Feedback error={action.error()} />
    </View>
  );
}
