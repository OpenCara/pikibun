import { Clipboard, effect, openUrl, signal, untracked, type Accessor } from "nsh";
import { managesSession, segment, type SessionRecord } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { pageAvailable, routeHash } from "../lib/page";
import { createAction, type Action } from "../lib/resource";
import { confirmArchive, confirmVisibilityChange, unarchiveNotice, visibilityNotice } from "../lib/session-actions";
import { Field, TextField } from "../form";
import { Button, Feedback, FormSheet, type MenuAction, type SwipeAction } from "../ui";

export const sessionLink = (id: string): string => `${session().origin}/${routeHash({ name: "session", sessionId: id })}`;

export interface SessionMenu {
  action: Action;
  items: (current: SessionRecord) => (MenuAction | "separator")[];
  /** The tiles behind a swiped row: dragged right, copying its link and renaming it; dragged left, `more` (the whole menu) and archiving it. */
  swipe: (current: SessionRecord, more: () => void) => { leading: SwipeAction[]; trailing: SwipeAction[] };
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

  /** What the person can do with the session, each where they may: the menu and the swipe tiles are made of these. */
  function actions(current: SessionRecord) {
    const { user } = untracked(session);
    const role = data.workspaces().find(workspace => workspace.id === current.workspaceId)?.role;
    const manages = managesSession(user.id, current.ownerId, role);
    const archived = current.status === "archived";
    const busy = action.busy();
    const packedForOthers = Boolean(current.packed) && current.ownerId !== user.id;
    const editable = manages && !archived;
    return {
      openTab: pageAvailable()
        ? { label: "Open in new tab", icon: "external-link", testID: "menu-open-tab", onSelect: () => void openUrl(sessionLink(current.id)).catch(() => undefined) } satisfies MenuAction
        : null,
      copyLink: { label: "Copy link", icon: "link", testID: "menu-copy-link", onSelect: () => void action.run(() => Clipboard.writeText(sessionLink(current.id)), "Link copied") } satisfies MenuAction,
      copyId: { label: "Copy session ID", icon: "copy", testID: "menu-copy-id", onSelect: () => void action.run(() => Clipboard.writeText(current.id), "Session ID copied") } satisfies MenuAction,
      rename: editable ? { label: "Rename", icon: "pencil", testID: "menu-rename", disabled: busy, onSelect: () => { action.clear(); renaming.set(current); } } satisfies MenuAction : null,
      visibility: editable
        ? { label: current.visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: current.visibility === "workspace" ? "lock" : "globe",
          testID: "menu-visibility", disabled: busy, onSelect: () => void changeVisibility(current) } satisfies MenuAction
        : null,
      archive: editable ? { label: "Archive", icon: "archive", testID: "menu-archive", disabled: busy, onSelect: () => void archive(current) } satisfies MenuAction : null,
      unarchive: manages && archived
        ? { label: "Unarchive", icon: "archive", testID: "menu-unarchive", disabled: busy || packedForOthers, hint: packedForOthers ? "Its files are packed: only its owner can" : undefined,
          onSelect: () => void action.run(async () => { await session().api(`${base(current)}/unarchive`, { method: "POST" }); changed(); }, unarchiveNotice(current)) } satisfies MenuAction
        : null,
    };
  }

  function items(current: SessionRecord): (MenuAction | "separator")[] {
    const { openTab, copyLink, copyId, rename, visibility, archive, unarchive } = actions(current);
    const menu: (MenuAction | "separator")[] = [...(openTab ? [openTab] : []), copyLink, copyId];
    if (rename && visibility && archive) menu.push("separator", rename, visibility, archive);
    if (unarchive) menu.push("separator", unarchive);
    return menu;
  }

  function swipe(current: SessionRecord, more: () => void): { leading: SwipeAction[]; trailing: SwipeAction[] } {
    const { copyLink, rename, archive, unarchive } = actions(current);
    const tile = (item: MenuAction, tone: SwipeAction["tone"], name: string): SwipeAction =>
      ({ label: item.label, icon: item.icon ?? "more", tone, disabled: item.disabled, testID: `swipe-${name}-${current.id}`, onPress: item.onSelect });
    const shelve = archive ? tile(archive, "warning", "archive") : unarchive ? tile(unarchive, "info", "unarchive") : null;
    return {
      leading: [tile(copyLink, "accent", "copy-link"), ...(rename ? [tile(rename, "info", "rename")] : [])],
      trailing: [{ label: "More", icon: "more", testID: `swipe-more-${current.id}`, onPress: more }, ...(shelve ? [shelve] : [])],
    };
  }

  return { action, items, swipe, renaming, rename: title => void rename(title), closeRename: () => renaming.set(null) };
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
