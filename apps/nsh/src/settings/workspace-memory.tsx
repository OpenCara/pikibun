import { effect, signal, View } from "nsh";
import { workspaceMemoryLimits, type WorkspaceMemoryNote, type WorkspaceMemoryView } from "../../../../packages/shared/src/workspace-memory";
import { segment, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import { Field, TextField } from "../form";
import { Badge, Button, CardBody, Feedback, IconButton, Note, ResourceState, Row, Section, Small } from "../ui";

export function noteLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return [`- ${lines[0] ?? ""}`, ...lines.slice(1).map(line => `  ${line}`)].join("\n");
}

export function withNote(memory: string, note: string): string {
  const base = memory.replace(/\s+$/, "");
  return `${base}${base ? "\n" : ""}${noteLine(note)}\n`;
}

export function WorkspaceMemorySettings(props: { workspace: Workspace }) {
  const path = () => `/api/workspaces/${segment(props.workspace.id)}/memory`;
  const resource = createResource<WorkspaceMemoryView>(path);
  const action = createAction();
  const instructions = signal("");
  const memory = signal("");
  const accepting = signal<string[]>([]);
  const view = () => resource.data();
  const admin = () => view()?.admin === true;
  effect(() => {
    const saved = view()?.memory;
    if (!saved) return;
    instructions.set(saved.instructions);
    memory.set(saved.memory);
    accepting.set([]);
  });
  const changed = () => {
    const saved = view()?.memory;
    return !!saved && (instructions() !== saved.instructions || memory() !== saved.memory || accepting().length > 0);
  };
  const tooLong = () => instructions().length > workspaceMemoryLimits.instructionsChars || memory().length > workspaceMemoryLimits.memoryChars;
  function save() {
    const saved = view()?.memory;
    if (!saved || !admin() || action.busy() || tooLong()) return;
    const body: Record<string, unknown> = { revision: saved.revision };
    if (instructions() !== saved.instructions) body.instructions = instructions();
    if (memory() !== saved.memory) body.memory = memory();
    if (accepting().length) body.accept = accepting();
    void action.run(async () => {
      await session().api(path(), { method: "PUT", body });
      resource.refresh();
    }, "Saved. Sessions here start their next message with it.");
  }
  function take(note: WorkspaceMemoryNote) {
    if (accepting().includes(note.id)) return;
    memory.set(withNote(memory(), note.text));
    accepting.update(ids => [...ids, note.id]);
  }
  function dismiss(note: WorkspaceMemoryNote) {
    if (action.busy()) return;
    void action.run(async () => {
      await session().api(`${path()}/notes`, { method: "POST", body: { notes: [note.id], status: "dismissed" } });
      resource.refresh();
    }, "Note dismissed.");
  }
  return (
    <Section title="Workspace memory" testID="workspace-memory" action={<IconButton icon="refresh" label="Refresh workspace memory" size={28} disabled={resource.loading()} onPress={resource.refresh} />}
      info={<View style={{ gap: 8 }}>
        <Note>What every session here starts with, as a project's knowledge in Claude Projects. Instructions say how to work here; the memory keeps what earlier sessions learned: decisions, conventions, pitfalls, where things live.</Note>
        <Note>Agents propose notes with the memory tool, and the notes wait here until an owner or admin adds them to the memory or dismisses them. Owners and admins can also have an agent go through them, or edit both texts here. Agents also search the workspace's earlier sessions.</Note>
        <Note>Every member reads them, and so does every session's model: keep secrets out.</Note>
      </View>}>
      <ResourceState inline loading={resource.loading() && !resource.data()} error={resource.error()} retry={resource.refresh}>
        <If when={view()}>
          {current => (
            <>
              <Row title="In sessions" hint={current().enabled ? "Every session's agent starts each message with these, and can propose notes"
                : "Off: add Workspace memory (piki:memory) under Extensions for sessions to use these"}
                trailing={<Badge tone={current().enabled ? "success" : "neutral"}>{current().enabled ? "On" : "Off"}</Badge>} />
              <CardBody>
                <Field label="Instructions" hint={`How to work in this workspace, for every session. ${instructions().length} of ${workspaceMemoryLimits.instructionsChars} characters.`}>
                  <TextField multiline minHeight={120} testID="workspace-memory-instructions" disabled={!admin()} value={instructions()} onChange={value => instructions.set(value)}
                    placeholder="Answer in English. Run pnpm check:fast before every push. Ask before changing the public API." />
                </Field>
                <Field label="Memory" hint={`What sessions here should know. ${memory().length} of ${workspaceMemoryLimits.memoryChars} characters${current().memory.revision ? `, revision ${current().memory.revision}, saved ${relativeTime(current().memory.updatedAt ?? "")}` : ""}.`}>
                  <TextField multiline monospace minHeight={200} testID="workspace-memory-text" disabled={!admin()} value={memory()} onChange={value => memory.set(value)}
                    placeholder="- The API server is apps/server; its migrations need both SQLite and Postgres." />
                </Field>
                <If when={!admin()}><Note>Only workspace owners and admins change these.</Note></If>
                <If when={admin() && (changed() || action.error() || action.notice())}>
                  <Feedback error={action.error() ?? (tooLong() ? "Shorten the text to fit its limit." : undefined)} notice={action.notice()} />
                  <If when={changed()}>
                    <View style={{ flexDirection: "row" }}>
                      <Button small variant="primary" label={accepting().length ? `Save, adding ${accepting().length} note${accepting().length === 1 ? "" : "s"}` : "Save"}
                        testID="workspace-memory-save" disabled={action.busy() || tooLong()} onPress={save} />
                    </View>
                  </If>
                </If>
              </CardBody>
              <Row title="Proposed notes" hint={current().pendingNotes ? `${current().pendingNotes} waiting${current().pendingNotes > current().notes.length ? `, the oldest ${current().notes.length} shown` : ""}` : "None waiting"} />
              <If when={current().notes.length} else={<CardBody><Small>Notes agents propose show here until someone keeps or dismisses them.</Small></CardBody>}>
                <Each of={current().notes} key={note => note.id}>
                  {note => (
                    <Row title={note().text} hint={`${note().sessionTitle ? `From “${note().sessionTitle}” · ` : ""}${relativeTime(note().createdAt)}`}
                      trailing={admin() ? <>
                        <Button small variant="outline" label={accepting().includes(note().id) ? "Added" : "Add to memory"} disabled={action.busy() || accepting().includes(note().id)}
                          onPress={() => take(note())} />
                        <Button small variant="ghost" label="Dismiss" disabled={action.busy()} onPress={() => dismiss(note())} />
                      </> : undefined} />
                  )}
                </Each>
              </If>
            </>
          )}
        </If>
      </ResourceState>
      <If when={!admin() && (action.error() || action.notice())}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}
