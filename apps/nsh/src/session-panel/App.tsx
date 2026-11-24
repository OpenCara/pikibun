import { signal, Text, View, WebView } from "nsh";
import { tunnelLinkHeld, validTunnelUrl, type SessionTunnelView } from "../../../../packages/shared/src/tunnel";
import type { SessionRecord } from "../../../../packages/shared/src/types";
import { openExternal } from "../lib/links";
import { Icon } from "../icons";
import { palette, text } from "../theme";
import { Badge, Button, EmptyState, IconButton, Small } from "../ui";
import { TabPage, type PanelTabProps } from "./parts";

export function tunnelFrameAddress(link: string): string | undefined {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  return validTunnelUrl(url.origin) && url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
}

const unshown = new Set(["ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "ERR_ACCESS_DENIED"]);

export function appUnavailable(current: SessionRecord, tunnel?: SessionTunnelView): string | null {
  if ((current.permissions ?? []).includes("write") && (!tunnel || tunnelLinkHeld(tunnel))) return null;
  return "Using the session's app takes the session collaborator role: your clicks and typing would go to it in the session's sandbox, as a collaborator's messages do. "
    + `Viewers follow the conversation${tunnel ? ", and see in Details that the app is online" : ""}.`;
}

export function App(props: PanelTabProps) {
  return (
    <If when={props.session()} else={<TabPage testID="panel-app"><Small>Loading…</Small></TabPage>}>
      {current => (
        <If when={!appUnavailable(current(), props.view()?.tunnel)}
          else={<TabPage testID="panel-app"><EmptyState title="App unavailable">{appUnavailable(current(), props.view()?.tunnel) ?? ""}</EmptyState></TabPage>}>
          <If when={props.view()?.tunnel} else={
            <TabPage testID="panel-app">
              <EmptyState title="Nothing online">
                When the agent puts the session's web app online with its tunnel, the app shows here, and you use it as it runs: your clicks and typing go
                to it in the session's sandbox. An app without a web page shows as a desktop, served with serve's desktop option.
              </EmptyState>
            </TabPage>
          }>
            {tunnel => <Online {...props} tunnel={tunnel} />}
          </If>
        </If>
      )}
    </If>
  );
}

function Online(props: PanelTabProps & { tunnel: () => SessionTunnelView }) {
  const loads = signal(0);
  const failure = signal<{ message: string; unshown: boolean } | null>(null);
  const address = () => tunnelFrameAddress(props.tunnel().url);
  const host = () => { try { return new URL(props.tunnel().url).host; } catch { return props.tunnel().url; } };
  const expanded = () => props.expanded?.() ?? false;
  const reload = () => { failure.set(null); loads.update(value => value + 1); };
  const open = () => openExternal(props.tunnel().url);
  return (
    <View testID="panel-app" style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette().border }}>
        <Icon name="globe" size={16} color={palette().muted} />
        <Text testID="app-address" style={{ flex: 1, numberOfLines: 1, fontSize: text.small, color: palette().text }}>{host()}</Text>
        <Badge tone={props.tunnel().connected ? "success" : "warning"} dot>{props.tunnel().connected ? "Online" : "Connecting"}</Badge>
        <IconButton testID="app-reload" icon="refresh" label="Load the app again" size={28} onPress={reload} />
        <IconButton testID="app-open" icon="external-link" label="Open in the browser" size={28} onPress={open} />
        <If when={props.setExpanded}>
          {set => <IconButton testID="app-expand" icon={expanded() ? "minimize" : "maximize"} size={28}
            label={expanded() ? "Back to the side panel" : "Expand to the full window"} onPress={() => set()(!expanded())} />}
        </If>
      </View>
      <If when={failure() ? undefined : address()} else={
        <TabPage testID="app-unavailable">
          <EmptyState title={failure()?.unshown === false ? "The app didn't load" : "This app can't show the session's app here"}
            action={<View style={{ flexDirection: "row", gap: 8 }}>
              <Button testID="app-open-instead" small variant="outline" icon="external-link" label="Open" onPress={open} />
              <If when={address() && failure()?.unshown === false}><Button testID="app-try-again" small variant="ghost" icon="refresh" label="Try again" onPress={reload} /></If>
            </View>}>
            {failure()?.unshown === false ? failure()!.message : "Open it in the browser instead: it is the same app, at the same address."}
          </EmptyState>
        </TabPage>
      }>
        {frame => (
          <Each of={[`${loads()}\u0000${frame()}`]} key={value => value}>
            {() => (
              <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
                <WebView testID="app-frame" src={frame()} incognito style={{ flex: 1 }}
                  onError={event => failure.set({ message: event.message || "The page couldn't be loaded.", unshown: unshown.has(event.code ?? "") })} />
              </View>
            )}
          </Each>
        )}
      </If>
      <If when={!expanded()}>
        <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderColor: palette().border }}>
          <Small>{`${props.tunnel().command} on port ${props.tunnel().port}, in the session's sandbox. Anyone with its link can use it too.`}</Small>
        </View>
      </If>
    </View>
  );
}
