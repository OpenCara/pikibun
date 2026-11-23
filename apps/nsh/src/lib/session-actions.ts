import { signal, type Accessor } from "nsh";
import type { BackupLocation, SessionRecord } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { session } from "./auth";
import { createAction, createResource, type Action, type Resource } from "./resource";
import { choose, confirm } from "../ui";

export type Backup = { id: string; sessionId: string; size: number; sha256: string; createdAt: string; location?: BackupLocation; unavailable?: boolean;
  automatic?: boolean; conversationOnly?: boolean };
export type BackupDatabase = { id: string; host: string; port: number; database: string; confirm: boolean; consented?: boolean };
export type AutomaticBackups = { minutes: number; included: boolean; attemptedAt: string | null; backupId: string | null; error: string | null; pending: boolean };
export type BackupListing = { backups: Backup[]; destination?: BackupLocation; workspaceDatabase?: BackupDatabase; enabled?: boolean;
  automaticBackups?: AutomaticBackups; conversationOnlySupported?: boolean };

export const backupDatabaseLabel = (database: BackupDatabase) => `${database.host.includes(":") ? `[${database.host}]` : database.host}:${database.port}/${database.database}`;

export interface SessionActions {
  action: Action;
  backup: Accessor<Backup | null>;
  backups: Resource<BackupListing>;
  backupsOff: Accessor<boolean>;
  backupsPending: Accessor<boolean>;
  conversationOnlyOff: Accessor<boolean>;
  backupBlocked: Accessor<boolean>;
  createBackup: (options?: { conversationOnly?: boolean }) => void;
  rename: (title: string) => Promise<boolean>;
  archive: () => void;
  unarchive: () => void;
  pack: () => void;
}

const archiveMessage = "The session becomes read-only for everyone and is hidden from the sidebar. Its history stays viewable, and nothing is deleted. You can unarchive it later.";

export function openDescendants(sessions: readonly SessionRecord[], id: string): SessionRecord[] {
  const byParent = new Map<string, SessionRecord[]>();
  for (const item of sessions) {
    if (!item.parentSessionId) continue;
    byParent.set(item.parentSessionId, [...(byParent.get(item.parentSessionId) ?? []), item]);
  }
  const found: SessionRecord[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      if (child.status !== "archived") found.push(child);
    }
  }
  return found;
}

export type ArchiveChoice = { children: boolean };

export async function confirmArchive(children = 0): Promise<ArchiveChoice | null> {
  if (children === 0) return await confirm({ title: "Archive session?", confirmLabel: "Archive", message: archiveMessage }) ? { children: false } : null;
  const started = children === 1 ? "1 open session it started" : `${children} open sessions it started`;
  const choice = await choose({ title: "Archive session?", message: `${archiveMessage}\n\nThis session started ${started}, directly or through them. Archive ${children === 1 ? "it" : "them"} too, or leave ${children === 1 ? "it" : "them"} open?`,
    choices: [{ id: "only", label: "Archive this one only" }, { id: "children", label: "Archive all" }] });
  return choice ? { children: choice === "children" } : null;
}

export async function archiveRequest(path: string, choice: ArchiveChoice): Promise<string> {
  if (!choice.children) {
    await session().api(path, { method: "POST" });
    return "Session archived";
  }
  const result = await session().api<{ children?: { archived: string[]; skipped: number; truncated?: boolean } }>(path, { method: "POST", body: { children: true } });
  const archived = result.children?.archived.length ?? 0;
  const skipped = result.children?.skipped ?? 0;
  const also = archived === 0 ? "" : archived === 1 ? " with 1 session it started" : ` with ${archived} sessions it started`;
  const left = skipped === 0 ? "" : skipped === 1 ? ". 1 you don't manage stays open" : `. ${skipped} you don't manage stay open`;
  const more = result.children?.truncated ? ". It started too many to archive at once: archive the rest from the list" : "";
  return `Session archived${also}${left}${more}`;
}

export const unarchiveNotice = (current: SessionRecord): string => (current.packed ? "Session unarchived, its files unpacked" : "Session unarchived");

export function createSessionActions(options: { session: Accessor<SessionRecord | null>; manages: Accessor<boolean>; backupBlocked: Accessor<boolean>; onChange: () => void;
  sessions?: Accessor<readonly SessionRecord[]> }): SessionActions {
  const action = createAction();
  const backup = signal<Backup | null>(null);
  const isOwner = () => options.session()?.ownerId === session().user.id;
  const backups = createResource<BackupListing>(() => {
    const current = options.session();
    return current && isOwner() && current.status !== "archived" ? `/api/sessions/${segment(current.id)}/backups` : null;
  });
  const backupsOff = () => backups.data()?.enabled === false;
  const backupsPending = () => !backups.data() && !backups.error();
  const conversationOnlyOff = () => backups.data()?.conversationOnlySupported === false;
  const base = () => `/api/sessions/${segment(options.session()!.id)}`;

  async function createBackup({ conversationOnly = false }: { conversationOnly?: boolean } = {}) {
    if (!options.session() || !isOwner() || options.backupBlocked() || backupsOff() || backupsPending() || action.busy() || (conversationOnly && conversationOnlyOff())) return;
    backup.set(null);
    let trustedDatabaseId: string | undefined;
    try {
      const { workspaceDatabase } = await session().api<{ workspaceDatabase?: BackupDatabase }>(`${base()}/backups`);
      if (workspaceDatabase?.confirm) {
        if (!await confirm({ title: "Save to the workspace database?", confirmLabel: "Save backup",
          message: `This backup is saved in ${backupDatabaseLabel(workspaceDatabase)}, the database the workspace owner connected. Whoever can read it can read this session: its prompts, output${conversationOnly ? "" : " and files"}, and your personal environment values.` })) return;
        trustedDatabaseId = workspaceDatabase.id;
      }
    } catch { }
    await action.run(async () => {
      const body = { ...(trustedDatabaseId ? { trustedDatabaseId } : {}), ...(conversationOnly ? { conversationOnly: true } : {}) };
      const result = await session().api<{ backup: Backup }>(`${base()}/backup`, { method: "POST", ...(Object.keys(body).length ? { body } : {}) });
      backup.set(result.backup);
      backups.refresh();
      options.onChange();
    }, conversationOnly ? "Conversation backup created" : "Backup created");
  }
  async function rename(title: string): Promise<boolean> {
    const current = options.session();
    const next = title.trim();
    if (!current || !options.manages() || action.busy() || !next) return false;
    if (next === current.title) return true;
    return action.run(async () => {
      await session().api(base(), { method: "PATCH", body: { title: next } });
      options.onChange();
    }, "Session renamed");
  }
  async function archive() {
    const current = options.session();
    if (!current || !options.manages() || action.busy() || current.status === "archived") return;
    const choice = await confirmArchive(openDescendants(options.sessions?.() ?? [], current.id).length);
    if (!choice) return;
    const path = `${base()}/archive`;
    let notice = "Session archived";
    await action.run(async () => {
      notice = await archiveRequest(path, choice);
      options.onChange();
    }, () => notice);
  }
  function unarchive() {
    const current = options.session();
    if (!current || !options.manages() || action.busy() || current.status !== "archived") return;
    void action.run(async () => {
      await session().api(`${base()}/unarchive`, { method: "POST" });
      options.onChange();
    }, unarchiveNotice(current));
  }
  async function pack() {
    const current = options.session();
    if (!current || !isOwner() || action.busy() || current.status !== "archived" || current.packed) return;
    if (!await confirm({ title: "Pack this session's files?", confirmLabel: "Pack files",
      message: "Its files on the host become one compressed file, to save the host's disk. Package caches and temporary files in its home folder are left out, and so are the dependencies and build output its clones' .gitignore ignores, such as node_modules, .venv and dist: install them again when you need them. Clones keep their branches, uncommitted changes and other ignored files, such as .env files (on hosts with a current connector), and are cloned again when the session is unarchived, which unpacks the rest. The conversation stays as it is." })) return;
    await action.run(async () => {
      await session().api(`${base()}/pack`, { method: "POST" });
      options.onChange();
    }, "Session files packed");
  }
  return {
    action, backup, backups, backupsOff, backupsPending, conversationOnlyOff, backupBlocked: options.backupBlocked,
    createBackup: value => void createBackup(value), rename,
    archive: () => void archive(), unarchive, pack: () => void pack(),
  };
}
