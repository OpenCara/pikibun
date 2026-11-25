import { host as embedder, mount, signal, Text, View } from "nsh";
import { Root } from "../../src/Root";
import { configurePush, type PushModule, type PushPress } from "../../src/lib/push";
import { Button } from "../../src/ui";

const params = embedder.params as { token?: unknown; refuses?: unknown; press?: unknown };
const said = signal<string[]>([]);
const say = (line: string) => said.update(list => [...list, line]);
const tokens = new Set<(token: { token: string }) => void>();
const presses = new Set<(press: PushPress) => void>();
let token = typeof params.token === "string" ? params.token : "a1b2c3";

const push: PushModule = {
  available: async () => true,
  async register() {
    say("register");
    if (params.refuses) throw new Error("no valid aps-environment entitlement string found for application");
    return { token };
  },
  setForegroundPresentation(presentation, thread) {
    say(`${presentation ? "quiet" : "shown"} ${thread?.threadId ?? "app"}`);
  },
  on(event: "token" | "press", listener: ((token: { token: string }) => void) | ((press: PushPress) => void)) {
    if (event === "token") {
      const heard = listener as (token: { token: string }) => void;
      tokens.add(heard);
      return () => { tokens.delete(heard); };
    }
    const heard = listener as (press: PushPress) => void;
    presses.add(heard);
    return () => { presses.delete(heard); };
  },
};
configurePush(push);

function changeToken() {
  token = "ffee00";
  for (const heard of tokens) heard({ token });
}

function press() {
  for (const heard of presses) heard({ id: "p1", threadId: "s1", payload: params.press });
}

mount(() => (
  <View style={{ flex: 1 }}>
    <View style={{ flex: 1 }}><Root /></View>
    <View testID="fake-push" style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      <Button small testID="fake-push-press" label="Press the push" onPress={press} />
      <Button small testID="fake-push-token" label="Change the token" onPress={changeToken} />
      <Each of={said()} key="index">{line => <Text>{`push ${line()}`}</Text>}</Each>
    </View>
  </View>
));
