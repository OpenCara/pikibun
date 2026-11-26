import { signal, Text, View } from "nsh";
import { segment, type ConnectorInfo } from "../shared";
import { validHostDirectory, type HostDirectoryListing, type HostDirectoryProblem } from "../../../../packages/shared/src/host-directory";
import { createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, text } from "../theme";
import { Banner, Button, Card, FormSheet, IconButton, ResourceState, Row, Small } from "../ui";

export const hostDirectoriesHref = (connectorId: string, path: string) => `/api/connectors/${segment(connectorId)}/directories?path=${encodeURIComponent(path)}`;

const problems: Record<HostDirectoryProblem, string> = {
  missing: "There's no directory here on the host.",
  denied: "The host's user can't read this directory.",
  "not-directory": "This is a file, not a directory.",
  refused: "This is Pikibun's own storage on the host, which no session works in.",
};

export function HostDirectoryPicker(props: { host: ConnectorInfo; start: string; onChoose: (path: string) => void; onClose: () => void }) {
  const path = signal(validHostDirectory(props.start) ? props.start : "~");
  const listing = createResource<{ directories: HostDirectoryListing }>(() => hostDirectoriesHref(props.host.id, path()));
  const current = () => listing.data()?.directories;
  const directory = () => { const value = current(); return value && "entries" in value ? value : null; };
  const problem = () => { const value = current(); return value && "problem" in value ? value.problem : null; };
  const go = (target: string) => path.set(target);
  return (
    <FormSheet open title={`Choose a directory on ${props.host.name}`} onClose={props.onClose} testID="host-directory-picker"
      footer={
        <>
          <Button variant="outline" label="Cancel" onPress={props.onClose} />
          <Button testID="host-directory-choose" variant="primary" label="Use this directory" disabled={!directory()?.usable}
            onPress={() => { const chosen = directory(); if (chosen?.usable) props.onChoose(chosen.path); }} />
        </>
      }>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <IconButton testID="host-directory-up" icon="arrow-up" label="Parent directory" size={28} disabled={!current()?.parent} onPress={() => { const up = current()?.parent; if (up) go(up); }} />
        <View selectable style={{ flex: 1, minWidth: 0 }}>
          <Text testID="host-directory-path" style={{ fontFamily: monospace, fontSize: text.small, color: palette().text }}>{current()?.path ?? path()}</Text>
        </View>
        <Button testID="host-directory-home" small variant="ghost" label="Home" disabled={!current() || current()!.path === current()!.home} onPress={() => go(current()?.home ?? "~")} />
        <IconButton icon="refresh" label="Refresh directories" size={28} disabled={listing.loading()} onPress={listing.refresh} />
      </View>
      <ResourceState inline loading={listing.loading() && !current()} error={listing.error()} retry={listing.refresh}>
        <If when={problem()}>
          {reason => (
            <Banner tone="warning" title="Can't open this directory"
              actions={<Button small variant="outline" label="Go to home" onPress={() => go(current()?.home ?? "~")} />}>
              <Text>{problems[reason()]}</Text>
            </Banner>
          )}
        </If>
        <If when={directory()}>
          {shown => (
            <>
              <Card testID="host-directory-list">
                <Each of={shown().entries} key={entry => entry.path}>
                  {entry => (
                    <Row testID={`host-directory-${entry().name}`} leading={<Icon name="folder" size={16} color={palette().muted} />} title={entry().name} chevron
                      onPress={() => go(entry().path)} />
                  )}
                </Each>
                <If when={!shown().entries.length}><Row title="No directories in here" /></If>
                <If when={shown().truncated}><Row title={`Showing the first ${shown().entries.length} directories`} hint="Type a longer path in the field to reach one further down" /></If>
              </Card>
              <If when={!shown().usable}>
                <Small tone="warning">A session can't work in this directory: it's the filesystem's root or holds Pikibun's own storage. Choose one inside it.</Small>
              </If>
            </>
          )}
        </If>
      </ResourceState>
    </FormSheet>
  );
}
