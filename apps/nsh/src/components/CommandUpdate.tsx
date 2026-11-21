import { signal, View, type ViewStyle } from "nsh";
import { hostsHere, staleCommands } from "../lib/this-computer";
import { Banner, Button } from "../ui";

const putOff = signal<string[]>([]);
const keyOf = (where: string, version: string, wanted: string) => `${where} ${version} ${wanted}`;

export function HomeCommandUpdate(props: { style?: ViewStyle; openLocalHosts: () => void }) {
  if (!hostsHere) return <></>;
  const shown = () => staleCommands().filter(item => !putOff().includes(keyOf(item.environment.key, item.stale.version, item.stale.wanted)));
  return (
    <If when={shown()[0]}>
      {first => (
        <View style={props.style}>
          <Banner testID="home-command-update" tone="warning" icon="download" title={`Update Pikibun's command ${first().environment.wsl ? "in" : "on"} ${first().environment.where()}`}
            actions={
              <>
                <Button testID="home-command-update-open" small variant="primary" label="Local hosts" onPress={props.openLocalHosts} />
                <Button testID="home-command-update-later" small variant="ghost" label="Later"
                  onPress={() => putOff.update(list => [...list, ...shown().map(item => keyOf(item.environment.key, item.stale.version, item.stale.wanted))])} />
              </>
            }>
            {`${first().environment.title()} runs its hosts with pikibun ${first().stale.version}, older than the ${first().stale.wanted} this version of Pikibun comes with, so they may miss fixes and features they need. Update it under Local hosts.`}
          </Banner>
        </View>
      )}
    </If>
  );
}
