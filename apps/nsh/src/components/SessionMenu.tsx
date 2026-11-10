import { Clipboard, effect, openUrl, signal, untracked, type Accessor } from "nsh";
import { managesSession, segment, type SessionRecord } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { pageAvailable, routeHash } from "../lib/page";
import { createAction, type Action } from "../lib/resource";
import { confirmArchive, confirmVisibilityChange, unarchiveNotice, visibilityNotice } from "../lib/session-actions";
import { Field, TextField } from "../form";
import { Button, Feedback, FormSheet, type MenuAction } from "../ui";

export const sessionLink = (id: string): string => `${session().origin}/${routeHash({ name: "session", sessionId: id })}`;

export interface SessionMenu {
  action: Action;
  items: (current: SessionRecord) => (MenuAction | "separator")[];
  renaming: Accessor<SessionRecord | null>;
  rename: (title: string) => void;
  closeRename: () => void;
}

export function createSessionMenu(): SessionMenu {
  const data = useAppData();
  const action = createAction();
  const renaming = signal<SessionRecord | null>(null);
  const base = (current: SessionRecord) => `/api/sessions/${segment(current.id)}`;
  const changed = () => data.refreshSessions();
  effect(() => {
    if (!action.notice()) return;
    const timer = setTimeout(() => action.clear(), 4000);
    return () => clearTimeout(timer);
  });

  async function changeVisibility(current: SessionRecord) {
    const next = await confirmVisibilityChange(current);
    if (next) await action.run(async () => { await session().api(base(current), { method: "PATCH", body: { visibility: next } }); changed(); }, visibilityNotice(next));
  }
  async function archive(current: SessionRecord) {
    if (await confirmArchive()) await action.run(async () => { await session().api(`${base(current)}/archive`, { method: "POST" }); changed(); }, "Session archived");
  }
  async function rename(title: string) {
    const current = untracked(renaming);
    const next = title.trim();
    if (!current || !next) return;
    if (next === current.title) { renaming.set(null); return; }
    if (await action.run(async () => { await session().api(base(current), { method: "PATCH", body: { title: next } }); changed(); }, "Session renamed")) renaming.set(null);
  }

  function items(current: SessionRecord): (MenuAction | "separator")[] {
    const { user } = untracked(session);
    const role = data.workspaces().find(workspace => workspace.id === current.workspaceId)?.role;
    const manages = managesSession(user.id, current.ownerId, role);
    const archived = current.status === "archived";
    const busy = action.busy();
    const menu: (MenuAction | "separator")[] = [
      ...(pageAvailable() ? [{ label: "Open in new tab", icon: "external-link" as const, testID: "menu-open-tab", onSelect: () => void openUrl(sessionLink(current.id)).catch(() => undefined) }] : []),
      { label: "Copy link", icon: "link", testID: "menu-copy-link", onSelect: () => void action.run(() => Clipboard.writeText(sessionLink(current.id)), "Link copied") },
      { label: "Copy session ID", icon: "copy", testID: "menu-copy-id", onSelect: () => void action.run(() => Clipboard.writeText(current.id), "Session ID copied") },
    ];
    if (manages && !archived) menu.push("separator",
      { label: "Rename", icon: "pencil", testID: "menu-rename", disabled: busy, onSelect: () => { action.clear(); renaming.set(current); } },
      { label: current.visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: current.visibility === "workspace" ? "lock" : "globe",
        testID: "menu-visibility", disabled: busy, onSelect: () => void changeVisibility(current) },
      { label: "Archive", icon: "archive", testID: "menu-archive", disabled: busy, onSelect: () => void archive(current) });
    if (manages && archived) menu.push("separator", { label: "Unarchive", icon: "archive", testID: "menu-unarchive",
      disabled: busy || (Boolean(current.packed) && current.ownerId !== user.id), hint: current.packed && current.ownerId !== user.id ? "Its files are packed: only its owner can" : undefined,
      onSelect: () => void action.run(async () => { await session().api(`${base(current)}/unarchive`, { method: "POST" }); changed(); }, unarchiveNotice(current)) });
    return menu;
  }

  return { action, items, renaming, rename: title => void rename(title), closeRename: () => renaming.set(null) };
}

export function RenameSheet(props: { open: boolean; title: string; busy: boolean; error?: string; onClose: () => void; onSave: (title: string) => void }) {
  const value = signal(untracked(() => props.title));
  effect(() => { if (props.open) value.set(untracked(() => props.title)); });
  return (
    <FormSheet open={props.open} title="Rename session" onClose={props.onClose}
      footer={<>
        <Button label="Cancel" disabled={props.busy} onPress={props.onClose} />
        <Button testID="rename-save" variant="primary" label={props.busy ? "Saving…" : "Save"} disabled={props.busy || !value().trim()} onPress={() => props.onSave(value())} />
      </>}>
      <Field label="Title"><TextField testID="rename-title" value={value()} onChange={next => value.set(next)} maxLength={200} autoFocus onSubmit={() => props.onSave(value())} /></Field>
      <Feedback error={props.error} />
    </FormSheet>
  );
}
