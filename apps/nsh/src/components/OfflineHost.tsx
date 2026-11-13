import { signal, View } from "nsh";
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
  const checked = signal(false);
  void Promise.all([
    hosts.load(),
    computer.load().then(() => (!computer.inspection() && computer.state() === "stopped" ? computer.refresh(props.server) : undefined)),
  ]).catch(() => undefined).finally(() => checked.set(true));
  const action = createAction();
  const here = () => ranHere(props.server, props.host.id);
  const paired = () => (checked() ? hosts.forServer(props.server) : undefined);
  const phase = () => paired()?.state() ?? "stopped";
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
    if (!checked()) return `This private session runs on ${props.host.name}, which is offline. Checking whether ${computerName} hosts for ${server}…`;
    const state = phase();
    if (paired() && state !== "stopped") {
      const own = `${computerTitle}'s host for ${server}`;
      if (state === "starting" || state === "connecting") return `${own} is starting. If this private session runs on ${here() ? computerName : props.host.name}${here() ? "" : ` and that's ${computerName}`}, it continues once the host is online.`;
      if (state === "disconnected") return `${own} lost its connection and is reconnecting by itself. This private session continues once ${here() ? "it" : `its host, ${props.host.name},`} is back online.`;
      if (state === "stopping") return `${own} is stopping. Start it again once it has stopped to continue this private session.`;
      return here()
        ? `This private session ran on ${computerName} under an earlier pairing with ${server}, which ${computerName} no longer has. Its files stay on ${computerName}, but it can't run again here.`
        : `This private session runs on ${props.host.name}, which is offline. ${own} is online, so it's another computer: open Pikibun on ${props.host.name} to continue the session.`;
    }
    if (here()) {
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
          <If when={paired() && phase() === "stopped"}
            else={<If when={checked() && !paired()}><Button small variant="outline" testID="session-host-connect" label={`Connect ${computerTitle}`} onPress={props.openSettings} /></If>}>
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
