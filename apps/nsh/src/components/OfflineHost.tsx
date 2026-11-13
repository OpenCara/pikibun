import { View } from "nsh";
import type { ConnectorInfo } from "../shared";
import { createAction } from "../lib/resource";
import { computerHosts, computerName, computerTitle, hostsHere, ranHere, thisComputer } from "../lib/this-computer";
import { Banner, Button, Feedback } from "../ui";

const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

export function OfflineHostBanner(props: { host: ConnectorInfo; server: string; openSettings: () => void }) {
  if (!hostsHere) {
    return (
      <Banner testID="session-host-offline" tone="warning" title={`${props.host.name} is offline`}>
        {`This private session runs on ${props.host.name}, one of your computers, and continues once its host is online. Open Pikibun there and start its host for ${hostOf(props.server)}, or run pikibun connect on it.`}
      </Banner>
    );
  }
  const hosts = computerHosts();
  const computer = thisComputer();
  void hosts.load();
  void computer.load().then(() => { if (!computer.inspection() && computer.state() === "stopped") void computer.refresh(props.server); });
  const action = createAction();
  const here = () => ranHere(props.server, props.host.id);
  const paired = () => hosts.forServer(props.server);
  const starting = () => { const host = paired(); return Boolean(host && host.state() !== "stopped"); };
  const start = () => {
    const host = paired();
    if (!host) return;
    void action.run(async () => {
      const outcome = await host.start(props.server);
      if (!outcome.ok) throw new Error(outcome.error ?? "The host didn't start.");
    });
  };
  const text = () => {
    const server = hostOf(props.server);
    if (here()) {
      if (starting()) return `This private session runs on ${computerName}. Its host for ${server} is starting; the session continues once it is online.`;
      if (paired()) return `This private session runs on ${computerName}, whose host for ${server} isn't running. Start it to continue the session.`;
      return `This private session ran on ${computerName}, which is no longer connected to ${server}. Connect ${computerTitle} to ${server} again to continue it: it keeps hosting for any other server too.`;
    }
    if (paired()) {
      return `This private session runs on ${props.host.name}, which is offline. If that's ${computerName}, start its host for ${server}; otherwise open Pikibun on ${props.host.name}.`;
    }
    return `This private session runs on ${props.host.name}, which is offline. If that's ${computerName}, connect ${computerTitle} to ${server} too, to continue it: it keeps hosting for any other server. Otherwise open Pikibun on ${props.host.name}.`;
  };
  return (
    <View style={{ gap: 8 }}>
    <Banner testID="session-host-offline" tone="warning" title={here() ? `${computerTitle} isn't hosting this session` : `${props.host.name} is offline`}
      actions={
        <View style={{ flexDirection: "row", gap: 8 }}>
          <If when={paired() && !starting()}
            else={<If when={!paired()}><Button small variant="outline" testID="session-host-connect" label={`Connect ${computerTitle}`} onPress={props.openSettings} /></If>}>
            <Button small variant="outline" testID="session-host-start" label="Start host" busy={action.busy()} disabled={action.busy()} onPress={start} />
          </If>
        </View>
      }>
      {text()}
    </Banner>
    <Feedback error={action.error()} />
    </View>
  );
}
