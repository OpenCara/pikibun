import { computed, effect, signal, untracked, View } from "nsh";
import type { ArtifactSummary } from "../../../../packages/shared/src/artifacts";
import { artifactsHref } from "../shared";
import { sessionArtifacts } from "../lib/artifacts";
import { relativeTime } from "../lib/format";
import { createResource } from "../lib/resource";
import { Icon } from "../icons";
import { palette } from "../theme";
import { Button, EmptyState, IconButton, ResourceState, Row, Section, Small } from "../ui";
import { artifactKindLabels, ArtifactViewer } from "../components/Artifact";
import { TabPage, type PanelTabProps } from "./parts";

export function Artifacts(props: PanelTabProps) {
  const listing = createResource<{ artifacts: ArtifactSummary[] }>(() => artifactsHref({ sessionId: props.sessionId }));
  const artifacts = () => listing.data()?.artifacts ?? [];
  const picked = signal<{ name: string; version?: number } | null>(null);
  const chosen = computed(() => {
    const current = picked();
    const artifact = current && artifacts().find(item => item.name === current.name);
    if (!artifact) return null;
    const latest = artifact.versions.length;
    return { artifact, version: current.version !== undefined && current.version <= latest ? current.version : latest };
  });
  props.backs?.add(() => {
    if (!untracked(picked)) return false;
    picked.set(null);
    return true;
  });
  let seen = "";
  effect(() => {
    const watched = `${props.view()?.entries.at(-1)?.id ?? ""}|${props.view()?.entries.length ?? 0}`;
    untracked(() => { if (seen && seen !== watched) void listing.refresh(); seen = watched; });
  });
  return (
    <TabPage testID="panel-artifacts">
      <If when={chosen()} else={
        <Section title="Artifacts" action={<IconButton icon="refresh" label="Refresh artifacts" size={28} disabled={listing.loading()} onPress={listing.refresh} />}>
          <ResourceState inline loading={listing.loading() && !listing.data()} error={listing.error()} retry={listing.refresh}>
            <If when={artifacts().length} else={
              <EmptyState title="No artifacts yet">When the agent publishes a report, a chart, a mock or a diagram with its publish_artifact tool, it shows here, with every version.</EmptyState>
            }>
              <Each of={artifacts()} key={item => item.name}>
                {item => {
                  const latest = () => item().versions.at(-1)!;
                  return (
                    <Row testID={`artifact-${item().name}`} title={latest().title} chevron onPress={() => picked.set({ name: item().name })}
                      leading={<Icon name="image" size={16} color={palette().muted} />}
                      hint={`${item().name} · ${artifactKindLabels[latest().kind]} · ${item().versions.length === 1 ? "1 version" : `${item().versions.length} versions`} · ${relativeTime(latest().createdAt)}`} />
                  );
                }}
              </Each>
            </If>
          </ResourceState>
        </Section>
      }>
        {current => {
          const info = () => current().artifact.versions[current().version - 1]!;
          const count = () => current().artifact.versions.length;
          const go = (version: number) => picked.set({ name: current().artifact.name, version });
          return (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Button small variant="ghost" icon="chevron-left" label="All artifacts" onPress={() => picked.set(null)} />
                <View style={{ flex: 1 }} />
                <IconButton icon="chevron-left" label="Earlier version" size={28} disabled={current().version <= 1} onPress={() => go(current().version - 1)} />
                <Small>{`Version ${current().version} of ${count()}`}</Small>
                <IconButton icon="chevron-right" label="Later version" size={28} disabled={current().version >= count()} onPress={() => go(current().version + 1)} />
              </View>
              <Section title={info().title}>
                <Each of={[`${current().artifact.name}@${current().version}`]} key={key => key}>
                  {() => <ArtifactViewer source={sessionArtifacts(props.sessionId)} name={current().artifact.name} version={current().version} height={480} />}
                </Each>
              </Section>
            </View>
          );
        }}
      </If>
    </TabPage>
  );
}
