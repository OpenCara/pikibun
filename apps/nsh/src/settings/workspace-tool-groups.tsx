import { signal, untracked, View } from "nsh";
import { adminManagedRoles } from "../../../../packages/shared/src/policy";
import {
  canonicalGroupTools, groupToolInfo, roleGroupNames, toolsLeftOut, type GroupTool, type ToolGroup, type ToolGroupMember, type ToolGroupSettings,
} from "../../../../packages/shared/src/tool-groups";
import type { WorkspaceRole } from "../../../../packages/shared/src/types";
import { segment, username, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { createAction, createResource } from "../lib/resource";
import { Checkbox, Field, Select, TextField } from "../form";
import { Badge, Button, CardBody, confirm, DropdownMenu, Feedback, FormSheet, Note, ResourceState, Row, Section, Small } from "../ui";

const kinds: { kind: (typeof groupToolInfo)[GroupTool]["kind"]; title: string }[] = [
  { kind: "files", title: "Files" },
  { kind: "commands", title: "Commands in the sandbox" },
  { kind: "publish", title: "Publishing and GitHub" },
  { kind: "workspace", title: "Workspace" },
];

const label = (tool: GroupTool) => groupToolInfo[tool].label;

function summary(names: readonly string[]): string {
  const tools = canonicalGroupTools(names);
  const out = toolsLeftOut(tools);
  if (!out.length) return "Every tool";
  if (!tools.length) return "No tools";
  return out.length <= tools.length ? `All but: ${out.map(label).join(", ")}` : `Only: ${tools.map(label).join(", ")}`;
}

const roleRows: { role: WorkspaceRole; roles: string }[] = [
  { role: "owner", roles: "Owners and admins" },
  { role: "collaborator", roles: "Collaborators" },
  { role: "member", roles: "Members" },
];

export function ToolGroups(props: { workspace: Workspace; owner: boolean }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/tool-groups`;
  const resource = createResource<ToolGroupSettings>(path);
  const action = createAction();
  const editing = signal<ToolGroup | "new" | null>(null);
  const settings = () => resource.data();
  const admin = () => settings()?.admin === true;
  const groupName = (member: ToolGroupMember) => settings()?.groups.find(group => group.id === member.groupId)?.name ?? roleGroupNames[member.role];
  const manages = (member: ToolGroupMember) => admin() && member.role !== "owner" && member.userId !== session().user.id
    && (props.owner || adminManagedRoles.includes(member.role));
  function assign(member: ToolGroupMember, groupId: string) {
    const next = groupId || null;
    if (next === member.groupId || action.busy()) return;
    void action.run(async () => {
      await session().api(`/api/workspaces/${segment(props.workspace.id)}/members/${segment(member.userId)}/tool-group`, { method: "PUT", body: { groupId: next } });
      resource.refresh();
    }, "Saved. Their sessions use these tools from their next tool call.");
  }
  async function remove(group: ToolGroup) {
    if (!await confirm({ title: `Delete ${group.name}?`, message: "Its members' sessions go back to the tools of their role.", confirmLabel: "Delete group", destructive: true })) return;
    void action.run(async () => {
      await session().api(`${path()}/${segment(group.id)}`, { method: "DELETE" });
      resource.refresh();
    }, `${group.name} deleted.`);
  }
  return (
    <>
      <Section title="Tool groups" testID="workspace-tool-groups" info={<View style={{ gap: 8 }}>
        <Note>A session has the tools of its owner's group, whoever writes in it and whatever access their messages use. A tool outside the group is neither offered to the agent nor run.</Note>
        <Note>Each member's sessions get the tools of their role, unless a workspace owner or admin puts them in a group of the workspace's own. Admins choose the group of collaborators, members and viewers; the owner also chooses admins'. The workspace's owner always has every tool.</Note>
        <Note>These are Pikibun's own tools. The tools of other extensions are switched under Extensions.</Note>
      </View>} action={admin() ? <Button small variant="outline" icon="plus" label="New group" testID="new-tool-group" onPress={() => editing.set("new")} /> : undefined}>
        <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
          <If when={settings()}>
            {current => (
              <>
                <Each of={roleRows} key={row => row.role}>
                  {row => <Row title={`${row().roles} (role)`} hint={<Small>{summary(current().roles[row().role])}</Small>} trailing={<Badge>Built in</Badge>} />}
                </Each>
                <Each of={current().groups} key={group => group.id}>
                  {group => {
                    const members = () => current().members.filter(member => member.groupId === group().id).length;
                    return (
                      <Row title={group().name} testID={`tool-group-${group().name}`}
                        hint={<Small>{`${summary(group().tools)} · ${members()} ${members() === 1 ? "member" : "members"}`}</Small>}
                        trailing={admin() ? <DropdownMenu label={`Actions for ${group().name}`} items={[
                          { label: "Edit", icon: "pencil", disabled: action.busy(), onSelect: () => editing.set(group()) },
                          { label: "Delete", icon: "trash", destructive: true, disabled: action.busy(), onSelect: () => void remove(group()) },
                        ]} /> : undefined} />
                    );
                  }}
                </Each>
              </>
            )}
          </If>
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
      <If when={settings()}>
        {current => (
          <Section title="Members' tools" testID="workspace-member-tools" info="The tool group of each member, which their sessions' tools follow.">
            <Each of={current().members} key={member => member.userId}>
              {member => (
                <Row title={member().displayName || username({ id: member().userId, username: member().username, githubLogin: member().githubLogin })}
                  hint={<Small>{summary(current().groups.find(group => group.id === member().groupId)?.tools ?? current().roles[member().role])}</Small>}
                  trailing={manages(member())
                    ? <Select<string> compact label={`Tool group of ${member().displayName}`} value={member().groupId ?? ""} disabled={action.busy()}
                      onChange={value => assign(member(), value)}
                      options={[{ value: "", label: `${roleGroupNames[member().role]} (role)` }, ...current().groups.map(group => ({ value: group.id, label: group.name }))]} />
                    : <Badge>{groupName(member())}</Badge>} />
              )}
            </Each>
          </Section>
        )}
      </If>
      <If when={editing()}>
        {group => <GroupEditor path={path()} group={group() === "new" ? null : group() as ToolGroup} close={() => editing.set(null)} saved={resource.refresh} />}
      </If>
    </>
  );
}

function GroupEditor(props: { path: string; group: ToolGroup | null; close: () => void; saved: () => void }) {
  const name = signal(untracked(() => props.group?.name ?? ""));
  const tools = signal<ReadonlySet<GroupTool>>(new Set(untracked(() => canonicalGroupTools(props.group?.tools ?? []))));
  const action = createAction();
  const toggle = (tool: GroupTool, on: boolean) => tools.update(current => {
    const next = new Set(current);
    if (on) next.add(tool); else next.delete(tool);
    return next;
  });
  function save() {
    if (action.busy() || !name().trim()) return;
    const body = { name: name().trim(), tools: [...tools()] };
    void action.run(async () => {
      if (props.group) await session().api(`${props.path}/${segment(props.group.id)}`, { method: "PATCH", body });
      else await session().api(props.path, { method: "POST", body });
      props.saved();
      props.close();
    });
  }
  return (
    <FormSheet open wide title={props.group ? `Edit ${props.group.name}` : "New tool group"} testID="tool-group-editor" onClose={() => { if (!action.busy()) props.close(); }}
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={props.close} />
        <Button variant="primary" testID="tool-group-save" label={action.busy() ? "Saving…" : "Save"} disabled={action.busy() || !name().trim()} onPress={save} />
      </>}>
      <Field label="Name" hint="Members you put in it see it as their tool group">
        <TextField testID="tool-group-name" value={name()} onChange={value => name.set(value)} placeholder="Releasers" autoFocus maxLength={80} />
      </Field>
      <Each of={kinds} key={item => item.kind}>
        {item => (
          <Field label={item().title}>
            <View style={{ gap: 6 }}>
              <Each of={(Object.keys(groupToolInfo) as GroupTool[]).filter(tool => groupToolInfo[tool].kind === item().kind)} key={tool => tool}>
                {tool => <Checkbox testID={`tool-${tool()}`} label={label(tool())} hint={tool()} checked={tools().has(tool())} disabled={action.busy()}
                  onChange={on => toggle(tool(), on)} />}
              </Each>
            </View>
          </Field>
        )}
      </Each>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
