import { signal, untracked, View } from "nsh";
import { BUILD_CACHE_ENV, BUILD_CACHE_NAME, buildCacheEnvAllowed, type StoredBuildCache } from "../../../../packages/shared/src/build-caches";
import type { ToolGroup, ToolGroupSettings } from "../../../../packages/shared/src/tool-groups";
import { segment, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Checkbox, Field, TextField } from "../form";
import { Button, CardBody, confirm, DropdownMenu, Feedback, FormSheet, Note, ResourceState, Row, Section, Small } from "../ui";

interface BuildCacheList {
  caches: StoredBuildCache[];
  admin: boolean;
  limits: { caches: number; writerGroups: number };
}

const deletedGroup = "deleted group";

function writerSummary(cache: Pick<StoredBuildCache, "writerGroups">, groups: readonly Pick<ToolGroup, "id" | "name">[] | undefined): string {
  if (!cache.writerGroups.length) return "Shared by owners, admins and collaborators who can write files";
  const names = cache.writerGroups.map(id => (groups ? groups.find(group => group.id === id)?.name ?? deletedGroup : id));
  return `Shared by the workspace's owner and: ${names.join(", ")}`;
}

function buildCacheProblems(input: { name: string; env: string }, caches: readonly StoredBuildCache[], editing: string | null): { name?: string; env?: string } {
  const problems: { name?: string; env?: string } = {};
  if (editing === null) {
    if (!BUILD_CACHE_NAME.test(input.name)) problems.name = "1 to 40 lowercase letters, digits and hyphens, starting with a letter or digit";
    else if (caches.some(cache => cache.name === input.name)) problems.name = `This workspace already has a build cache named ${input.name}`;
  }
  if (!BUILD_CACHE_ENV.test(input.env)) problems.env = "1 to 64 uppercase letters, digits and underscores, not starting with a digit";
  else if (!buildCacheEnvAllowed(input.env)) problems.env = `${input.env} is a variable the sandbox or the tools set themselves; name another`;
  else {
    const clash = caches.find(cache => cache.env === input.env && cache.name !== editing);
    if (clash) problems.env = `The build cache ${clash.name} already uses ${input.env}`;
  }
  return problems;
}

export function BuildCaches(props: { workspace: Workspace }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/build-caches`;
  const resource = createResource<BuildCacheList>(path);
  const groups = createResource<ToolGroupSettings>(() => `/api/workspaces/${segment(props.workspace.id)}/tool-groups`);
  const action = createAction();
  const editing = signal<StoredBuildCache | "new" | null>(null);
  const list = () => resource.data();
  const admin = () => list()?.admin === true;
  const full = () => (list()?.caches.length ?? 0) >= (list()?.limits.caches ?? Infinity);
  async function remove(cache: StoredBuildCache) {
    if (!await confirm({ title: `Delete ${cache.name}?`, confirmLabel: "Delete cache", destructive: true,
      message: `Sessions stop getting ${cache.env} from their next command. Hosts keep what the cache holds until pikibun cache prune removes it.` })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(cache.name)}`, { method: "DELETE" });
      resource.refresh();
    }, `${cache.name} deleted.`);
  }
  return (
    <>
      <Section title="Build caches" testID="workspace-build-caches" info={<View style={{ gap: 8 }}>
        <If when={!admin()}><Note>Only workspace owners and admins can change these.</Note></If>
        <Note>A build cache is a directory a host keeps for this workspace. Commands find its path in the variable you name, so tools that keep a cache directory (ccache's CCACHE_DIR, sccache's SCCACHE_DIR, Gradle's build cache, Bazel's --disk_cache, Turborepo, Nx) reuse earlier builds instead of starting again.</Note>
        <Note>Whoever writes a cache can change what every session reading it builds and runs, and nothing can check its entries. So the sessions of the workspace's owner, its admins and its collaborators whose tool group can write files share one copy: they can already change each other's sessions. Members, and collaborators who can't write files, get their own copy.</Note>
        <Note>Writer groups narrow who shares it: then only the workspace's owner and the people of those groups who pass that rule do. A deleted group still leaves the copy to the workspace's owner, never to everyone.</Note>
        <Note>Hosts keep caches only where their owner turns on Build caches in the host's configuration; a host set to Per owner gives everyone their own copy. Caches never enter backups, packs or moves.</Note>
      </View>} action={admin() ? <Button small variant="outline" icon="plus" label="Add cache" testID="new-build-cache" disabled={full()} onPress={() => editing.set("new")} /> : undefined}>
        <CardBody><Small>Owners, admins and collaborators who can write files share each cache's copy; members get their own. Hosts must turn Build caches on.</Small></CardBody>
        <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
          <If when={list()}>
            {current => (
              <>
                <If when={current().caches.length === 0}>
                  <Row title="No build caches" hint={<Small>{admin() ? "Add one for each tool whose cache directory sessions should keep between builds" : "The workspace's owners and admins add them"}</Small>} />
                </If>
                <Each of={current().caches} key={cache => cache.name}>
                  {cache => (
                    <Row title={cache().name} testID={`build-cache-${cache().name}`}
                      hint={<Small>{`${cache().env} · ${writerSummary(cache(), groups.data()?.groups)}`}</Small>}
                      trailing={admin() ? <DropdownMenu label={`Actions for ${cache().name}`} testID={`build-cache-actions-${cache().name}`} items={[
                        { label: "Edit", icon: "pencil", disabled: action.busy(), onSelect: () => editing.set(cache()) },
                        { label: "Delete", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void remove(cache()) },
                      ]} /> : undefined} />
                  )}
                </Each>
                <If when={admin() && full()}>
                  <Row title="Limit reached" hint={<Small>{`A workspace has at most ${current().limits.caches} build caches.`}</Small>} />
                </If>
              </>
            )}
          </If>
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
      <If when={editing() && list()}>
        <BuildCacheEditor path={path()} cache={editing() === "new" ? null : editing() as StoredBuildCache} caches={list()!.caches}
          groups={groups.data()?.groups ?? []} maxGroups={list()!.limits.writerGroups} close={() => editing.set(null)} saved={resource.refresh} />
      </If>
    </>
  );
}

function BuildCacheEditor(props: {
  path: string; cache: StoredBuildCache | null; caches: StoredBuildCache[]; groups: ToolGroup[]; maxGroups: number; close: () => void; saved: () => void;
}) {
  const name = signal(untracked(() => props.cache?.name ?? ""));
  const env = signal(untracked(() => props.cache?.env ?? ""));
  const writers = signal<readonly string[]>(untracked(() => props.cache?.writerGroups ?? []));
  const touched = signal(false);
  const action = createAction();
  const deleted = untracked(() => (props.cache?.writerGroups ?? []).filter(id => !props.groups.some(group => group.id === id)));
  const tooMany = () => writers().length > props.maxGroups;
  const widened = () => Boolean(props.cache?.writerGroups.length) && writers().length === 0;
  const problems = () => buildCacheProblems({ name: name().trim(), env: env().trim() }, props.caches, props.cache?.name ?? null);
  const invalid = () => Boolean(problems().name || problems().env) || writers().length > props.maxGroups;
  const toggle = (id: string, on: boolean) => writers.update(current => (on ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id)));
  function save() {
    touched.set(true);
    if (action.busy() || invalid()) return;
    const cacheName = props.cache?.name ?? name().trim();
    void action.run(async () => {
      await session().api(`${props.path}/${segment(cacheName)}`, { method: "PUT", body: { env: env().trim(), writerGroups: [...writers()] } });
      props.saved();
      props.close();
    });
  }
  return (
    <FormSheet open title={props.cache ? `Edit ${props.cache.name}` : "New build cache"} testID="build-cache-editor" onClose={() => { if (!action.busy()) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={props.close} />
        <Button variant="primary" testID="build-cache-save" label={action.busy() ? "Saving…" : "Save"} disabled={action.busy()} onPress={save} />
      </>}>
      <If when={!props.cache}>
        <Field label="Name" hint="Names the cache's directory on hosts" error={touched() || name() ? problems().name : undefined}>
          <TextField testID="build-cache-name" monospace autoCapitalize="none" autoCorrect={false} autoFocus maxLength={40} value={name()} onChange={value => name.set(value)} placeholder="ccache" />
        </Field>
      </If>
      <Field label="Variable" hint="Commands get the cache's path in this environment variable" error={touched() || env() ? problems().env : undefined}>
        <TextField testID="build-cache-env" monospace autoCapitalize="characters" autoCorrect={false} autoFocus={Boolean(props.cache)} maxLength={64} value={env()}
          onChange={value => env.set(value)} placeholder="CCACHE_DIR" />
      </Field>
      <Field label="Writer groups" hint={`Optional, at most ${props.maxGroups}. With none, the role rule alone decides who shares the copy; with some, only the workspace's owner and those groups' people who pass it do.`}
        error={tooMany() ? `Choose at most ${props.maxGroups} writer groups.` : widened() ? "With no writer groups left, every admin and collaborator who can write files shares this cache's copy." : undefined}>
        <View style={{ gap: 6 }}>
          <Each of={props.groups} key={group => group.id}>
            {group => <Checkbox testID={`build-cache-group-${group().id}`} label={group().name} checked={writers().includes(group().id)} disabled={action.busy()}
              onChange={on => toggle(group().id, on)} />}
          </Each>
          <Each of={deleted} key={id => id}>
            {id => <Checkbox testID={`build-cache-group-${id()}`} label={`${deletedGroup} (${id()})`} hint="Still narrows the copy to the workspace's owner until you untick it"
              checked={writers().includes(id())} disabled={action.busy()} onChange={on => toggle(id(), on)} />}
          </Each>
          <If when={props.groups.length === 0 && deleted.length === 0}><Small>This workspace has no tool groups of its own; add them under Tool groups.</Small></If>
        </View>
      </Field>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
