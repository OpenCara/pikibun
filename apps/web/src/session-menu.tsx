import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { SessionRecord } from "../../../packages/shared/src/types";
import { managesSession } from "../../../packages/shared/src/policy";
import { api, errorMessage, segment } from "./api";
import { useApp } from "./app-context";
import { desktopBridge } from "./desktop";
import { href } from "./router";
import { confirmArchive, confirmVisibilityChange, unarchiveNotice, visibilityNotice } from "./session-panel";
import { Button, Feedback, Field, Sheet, type MenuEntry } from "./ui";

/** The full address of an app page, as the address bar shows it: what Copy link copies and a new window opens. */
export function pageLink(hash: string): string {
  return new URL(hash, window.location.href).href;
}

/** Copies `text`, then says so (or why it couldn't). */
export function copyWithNotice(text: string, done: string, notify: (text: string, options?: { error?: boolean }) => void): void {
  navigator.clipboard.writeText(text).then(() => notify(done), () => notify("Couldn't copy to the clipboard", { error: true }));
}

/** Opens an app page in a new tab, or in the desktop app a new Pikibun window (its window-open handler). */
export function openInNewWindow(hash: string): void {
  window.open(pageLink(hash), "_blank", "noopener");
}

export const newWindowLabel = (): string => desktopBridge() ? "Open in new window" : "Open in new tab";

/**
 * The right-click menu of a session in a list (the sidebar, the Sessions page): opening and copying it for everyone; to
 * its owner and its workspace's owner and admins (managesSession) Rename, visibility and Archive, or Unarchive, as the
 * session's own menu offers them, with the same confirmations. `notify` reports results, which have no place on screen
 * here. `element` holds the rename sheet: render it once beside the list.
 */
export function useSessionMenu(notify: (text: string, options?: { error?: boolean }) => void): { items: (session: SessionRecord) => MenuEntry[]; element: ReactNode } {
  const { user, workspaces, refreshSessions } = useApp();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<SessionRecord | null>(null);
  const [renameError, setRenameError] = useState("");
  const startRename = (session: SessionRecord | null) => { setRenameError(""); setRenaming(session); };

  /** `failed` takes a failure's message where the corner's note can't be seen (behind the modal rename sheet). */
  async function run(work: () => Promise<void>, success: string, failed: (message: string) => void = message => notify(message, { error: true })): Promise<boolean> {
    setBusy(true);
    try {
      await work();
      refreshSessions();
      notify(success);
      return true;
    } catch (reason) {
      failed(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeVisibility(session: SessionRecord) {
    const next = await confirmVisibilityChange(session);
    if (next) await run(() => api(`/api/sessions/${segment(session.id)}`, { method: "PATCH", body: { visibility: next } }), visibilityNotice(next));
  }

  async function archive(session: SessionRecord) {
    if (await confirmArchive()) await run(() => api(`/api/sessions/${segment(session.id)}/archive`, { method: "POST" }), "Session archived");
  }

  async function rename(session: SessionRecord, title: string) {
    if (title === session.title) { startRename(null); return; }
    setRenameError("");
    if (await run(() => api(`/api/sessions/${segment(session.id)}`, { method: "PATCH", body: { title } }), "Session renamed", setRenameError)) startRename(null);
  }

  function items(session: SessionRecord): MenuEntry[] {
    const link = href({ name: "session", sessionId: session.id });
    const isOwner = session.ownerId === user.id;
    const role = workspaces.find(workspace => workspace.id === session.workspaceId)?.role;
    const manages = managesSession(user.id, session.ownerId, role);
    const archived = session.status === "archived";
    const visibility = session.visibility ?? "private";
    const menu: MenuEntry[] = [
      { label: newWindowLabel(), icon: "external", onSelect: () => openInNewWindow(link) },
      { label: "Copy link", icon: "link", onSelect: () => copyWithNotice(pageLink(link), "Link copied", notify) },
      { label: "Copy session ID", icon: "copy", onSelect: () => copyWithNotice(session.id, "Session ID copied", notify) },
    ];
    if (manages && !archived) menu.push("separator",
      { label: "Rename", icon: "pencil", disabled: busy, onSelect: () => startRename(session) },
      { label: visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: visibility === "workspace" ? "lock" : "globe", disabled: busy, onSelect: () => void changeVisibility(session) },
      { label: "Archive", icon: "archive", disabled: busy, onSelect: () => void archive(session) });
    // Packed files come back as the session is unarchived, which only its owner may then do.
    if (manages && archived) menu.push("separator", { label: "Unarchive", icon: "archive", disabled: busy || (Boolean(session.packed) && !isOwner),
      hint: session.packed && !isOwner ? "Its files are packed: only its owner can" : undefined,
      onSelect: () => void run(() => api(`/api/sessions/${segment(session.id)}/unarchive`, { method: "POST" }), unarchiveNotice(session)) });
    return menu;
  }

  const element = <RenameSheet open={renaming !== null} title={renaming?.title ?? ""} busy={busy} error={renameError} onClose={() => startRename(null)}
    onSave={title => { if (renaming) void rename(renaming, title); }} />;
  return { items, element };
}

/** `error`: why the last save failed, shown in the sheet, as the page behind a modal sheet can't be seen. */
export function RenameSheet({ open, title, busy, error, onClose, onSave }: { open: boolean; title: string; busy: boolean; error?: string; onClose: () => void; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  // Start from the current title each time the sheet opens.
  useEffect(() => { if (open) setValue(title); }, [open, title]);
  const next = value.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (next && !busy) onSave(next);
  }
  return <Sheet open={open} title="Rename session" onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button type="submit" form="rename-session-form" variant="default" disabled={busy || !next}>{busy ? "Saving..." : "Rename"}</Button>
  </>}>
    <form id="rename-session-form" className="stack" onSubmit={submit}>
      <Field label="Title">
        <input className="input" required autoFocus maxLength={200} value={value} onChange={event => setValue(event.target.value)} autoComplete="off" />
      </Field>
      <Feedback error={error} />
    </form>
  </Sheet>;
}
