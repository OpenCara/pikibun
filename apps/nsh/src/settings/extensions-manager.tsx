import { signal, Text, untracked, View } from "nsh";
import {
  pikiCommandExtensions, pikiControlPlaneExtensions, pikiExtension, pikiSessionToolExtensions, pikiWorkflowExtensions, sessionToolExtensionOn, type PikiExtensionInfo,
} from "../../../../packages/shared/src/piki-extensions";
import { descriptionSummary } from "../../../../packages/shared/src/workspace-tools";
import { extensionLimits, type WorkspaceExtension } from "../../../../packages/shared/src/host-extensions";
import { palette, text } from "../theme";
import { Checkbox, TextField } from "../form";
import { Button, Feedback, FormSheet, Note, Small } from "../ui";

export interface ManagedExtension {
  source: string;
  title: string;
  description?: string;
  on: boolean;
  sessionTool: boolean;
  existing?: WorkspaceExtension;
}

export interface ManagedGroup { name: string; hint: string; items: ManagedExtension[] }

export interface ExtensionChange { source: string; enabled: boolean; remove?: boolean; extension?: WorkspaceExtension }

export function managedExtensionGroups(extensions: readonly WorkspaceExtension[]): ManagedGroup[] {
  const seen = new Set<string>();
  const of = (item: PikiExtensionInfo, sessionTool: boolean): ManagedExtension => {
    const existing = extensions.find(extension => extension.source === item.source);
    return {
      source: item.source, title: item.title, description: item.description, sessionTool, ...(existing ? { existing } : {}),
      on: sessionTool ? sessionToolExtensionOn(extensions, item.source) : existing?.enabled === true,
    };
  };
  const take = (items: readonly PikiExtensionInfo[], sessionTool: boolean) => items.filter(item => {
    if (seen.has(item.source)) return false;
    seen.add(item.source);
    return true;
  }).map(item => of(item, sessionTool));
  const sessionTools = pikiSessionToolExtensions().filter(item => !item.retired && !item.core);
  for (const item of pikiSessionToolExtensions().filter(item => item.retired || item.core)) seen.add(item.source);
  const groups: ManagedGroup[] = [
    { name: "Pikibun tools", hint: "The session's own tools, in its sandbox or through Pikibun", items: take(sessionTools, true) },
    { name: "Command-line tools", hint: "Come with every host's connector: each host needs only the command, signed in", items: take(pikiCommandExtensions(), false) },
    { name: "Workflows", hint: "Guide how the agent works, and add no tools", items: take(pikiWorkflowExtensions(), false) },
    { name: "Pikibun features", hint: "Run in Pikibun itself: nothing is installed on hosts", items: take(pikiControlPlaneExtensions(), false) },
  ];
  const others = extensions.filter(extension => !seen.has(extension.source)).map(extension => {
    const known = pikiExtension(extension.source);
    return { source: extension.source, title: known?.title ?? extension.source, description: known?.description, sessionTool: false, existing: extension, on: extension.enabled };
  });
  groups.push({ name: "Other extensions", hint: "Pi extensions this workspace added, from npm, git or Pikibun", items: others });
  return groups.filter(group => group.items.length);
}

export function extensionChanges(groups: readonly ManagedGroup[], chosen: Readonly<Record<string, boolean>>): ExtensionChange[] {
  const changes: ExtensionChange[] = [];
  for (const item of groups.flatMap(group => group.items)) {
    const want = chosen[item.source] ?? item.on;
    if (want === item.on) continue;
    if (item.sessionTool) changes.push(want ? { source: item.source, enabled: true, extension: { source: item.source, enabled: true, tools: "automatic", settings: {} } }
      : { source: item.source, enabled: false, remove: true });
    else if (item.existing) changes.push({ source: item.source, enabled: want, extension: { ...item.existing, enabled: want } });
    else if (want) changes.push({ source: item.source, enabled: true, extension: { source: item.source, enabled: true, tools: "automatic", settings: {} } });
  }
  return [...changes.filter(change => change.enabled), ...changes.filter(change => !change.enabled)];
}

export function addedPlaces(groups: readonly ManagedGroup[], chosen: Readonly<Record<string, boolean>>): number {
  return groups.flatMap(group => group.items).filter(item => !item.sessionTool && !item.existing && (chosen[item.source] ?? item.on)).length;
}

export function ExtensionsManager(props: {
  extensions: readonly WorkspaceExtension[]; used: number;
  close: () => void; apply: (changes: ExtensionChange[]) => Promise<void>; busy: boolean; error: string;
}) {
  const groups = untracked(() => managedExtensionGroups(props.extensions));
  const chosen = signal<Record<string, boolean>>(Object.fromEntries(groups.flatMap(group => group.items).map(item => [item.source, item.on])));
  const filter = signal("");
  const matches = (item: ManagedExtension) => {
    const query = filter().trim().toLowerCase();
    return !query || `${item.title} ${item.source} ${item.description ?? ""}`.toLowerCase().includes(query);
  };
  const shown = () => groups.map(group => ({ ...group, items: group.items.filter(matches) })).filter(group => group.items.length);
  const changes = () => extensionChanges(groups, chosen());
  const over = () => props.used + addedPlaces(groups, chosen()) > extensionLimits.workspace;
  const setAll = (items: readonly ManagedExtension[], on: boolean) => chosen.set({ ...chosen(), ...Object.fromEntries(items.map(item => [item.source, on])) });
  const visible = () => shown().flatMap(group => group.items);
  return (
    <FormSheet open wide testID="extensions-manager" title="Manage extensions" onClose={() => { if (!props.busy) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.close} />
        <Button testID="extensions-manager-save" variant="primary" disabled={props.busy || !changes().length || over()}
          label={props.busy ? "Saving…" : changes().length ? `Save ${changes().length} ${changes().length === 1 ? "change" : "changes"}` : "Save"} onPress={() => void props.apply(changes())} />
      </>}>
      <Note>Turn any of the workspace's extensions on or off here, then save them together. Sessions pick the changes up from their next message. Edit an extension's settings from its row.</Note>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 180 }}>
          <TextField testID="extensions-manager-filter" value={filter()} onChange={value => filter.set(value)} placeholder="Filter extensions" disabled={props.busy} maxLength={100} />
        </View>
        <Button testID="extensions-manager-all-on" small variant="outline" label="All on" disabled={props.busy || !visible().length} onPress={() => setAll(visible(), true)} />
        <Button testID="extensions-manager-all-off" small variant="outline" label="All off" disabled={props.busy || !visible().length} onPress={() => setAll(visible(), false)} />
      </View>
      <If when={!shown().length}><Small>No extension matches.</Small></If>
      <Each of={shown()} key={group => group.name}>
        {group => (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: text.body, fontWeight: "500", color: palette().text }}>{group().name}</Text>
                <Small>{`${group().hint} · ${group().items.filter(item => chosen()[item.source]).length} of ${group().items.length} on`}</Small>
              </View>
              <Button small variant="ghost" label="All on" disabled={props.busy} onPress={() => setAll(group().items, true)} />
              <Button small variant="ghost" label="All off" disabled={props.busy} onPress={() => setAll(group().items, false)} />
            </View>
            <Each of={group().items} key={item => item.source}>
              {item => (
                <Checkbox testID={`manage-${item().source}`} label={`${item().title}${item().title === item().source ? "" : ` · ${item().source}`}`}
                  hint={[item().description ? descriptionSummary(item().description!, 160) : "",
                    chosen()[item().source] !== item().on ? (chosen()[item().source] ? "Turns on when saved" : "Turns off when saved") : ""].filter(Boolean).join(" · ") || undefined}
                  checked={chosen()[item().source] === true} disabled={props.busy}
                  onChange={value => chosen.set({ ...chosen(), [item().source]: value })} />
              )}
            </Each>
          </View>
        )}
      </Each>
      <If when={over()}><Small tone="danger">{`A workspace uses at most ${extensionLimits.workspace} extensions besides Pikibun's tools: turn some new ones off, or remove extensions it doesn't need.`}</Small></If>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
