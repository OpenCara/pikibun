import { signal, type Accessor } from "nsh";
import type { BackupLocation, SessionRecord } from "../../../../packages/shared/src/types";
import { segment } from "../shared";
import { session } from "./auth";
import { createAction, createResource, type Action, type Resource } from "./resource";
import { confirm } from "../ui";

// What can be done to a session as a whole, shared by its header's menu and its panel (the web app's
// useSessionActions, session-panel.tsx).

export type Backup = { id: string; sessionId: string; size: number; sha256: string; createdAt: string; location?: BackupLocation; unavailable?: boolean;
  automatic?: boolean; conversationOnly?: boolean };
export type BackupDatabase = { id: string; host: string; port: number; database: string; confirm: boolean; consented?: boolean };
export type AutomaticBackups = { minutes: number; included: boolean; attemptedAt: string | null; backupId: string | null; error: string | null; pending: boolean };
export type BackupListing = { backups: Backup[]; destination?: BackupLocation; workspaceDatabase?: BackupDatabase; enabled?: boolean;
  automaticBackups?: AutomaticBackups; conversationOnlySupported?: boolean };

export const backupDatabaseLabel = (database: BackupDatabase) => `${database.host.includes(":") ? `[${database.host}]` : database.host}:${database.port}/${database.database}`;

export interface SessionActions {
  action: Action;
  /** The backup just created here. */
  backup: Accessor<Backup | null>;
  backups: Resource<BackupListing>;
  backupsOff: Accessor<boolean>;
  backupsPending: Accessor<boolean>;
  conversationOnlyOff: Accessor<boolean>;
  /** Backups need an idle session whose live state is confirmed. */
  backupBlocked: Accessor<boolean>;
  changeVisibility: () => void;
  createBackup: (options?: { conversationOnly?: boolean }) => void;
  rename: (title: string) => Promise<boolean>;
  archive: () => void;
  unarchive: () => void;
  pack: () => void;
}

/**
 * `manages`: its owner, or its workspace's owner or an admin, who rename, archive and unarchive it and change its
 * visibility. Backups stay the owner's alone, and need an idle session (`backupBlocked`).
 */
export function createSessionActions(options: { session: Accessor<SessionRecord | null>; manages: Accessor<boolean>; backupBlocked: Accessor<boolean>; onChange: () => void }): SessionActions {
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

  async function changeVisibility() {
    const current = options.session();
    if (!current || !options.manages() || action.busy()) return;
    const next = (current.visibility ?? "private") === "workspace" ? "private" : "workspace";
    if (!await confirm(next === "workspace" ? {
      title: "Make session workspace-visible?", confirmLabel: "Make workspace-visible",
      message: "All workspace members will be able to view existing and future prompts and output, including tool output, repository content shown in the transcript, and side asks, which may contain sensitive information. This grants viewing only, not direct GitHub access, permission to run tools, or ask/control permissions.",
    } : {
      title: "Make session private?", confirmLabel: "Make private",
      message: "Workspace membership will no longer grant viewing access, except to the workspace's owner and admins, who manage every session. Existing explicit grants will remain in effect, and previously viewed or copied content cannot be recalled.",
    })) return;
    await action.run(async () => {
      await session().api(base(), { method: "PATCH", body: { visibility: next } });
      options.onChange();
    }, next === "workspace" ? "Session is workspace-visible. Workspace members can view prompts and output." : "Session is private. Existing explicit grants still apply.");
  }
  async function createBackup({ conversationOnly = false }: { conversationOnly?: boolean } = {}) {
    if (!options.session() || !isOwner() || options.backupBlocked() || backupsOff() || backupsPending() || action.busy() || (conversationOnly && conversationOnlyOff())) return;
    backup.set(null);
    let trustedDatabaseId: string | undefined;
    try {
      // A backup saved where someone else can read it waits for the owner's explicit confirmation of that database.
      const { workspaceDatabase } = await session().api<{ workspaceDatabase?: BackupDatabase }>(`${base()}/backups`);
      if (workspaceDatabase?.confirm) {
        if (!await confirm({ title: "Save to the workspace database?", confirmLabel: "Save backup",
          message: `This backup is saved in ${backupDatabaseLabel(workspaceDatabase)}, the database the workspace owner connected. Whoever can read it can read this session: its prompts, output${conversationOnly ? "" : " and files"}, and your personal environment values.` })) return;
        trustedDatabaseId = workspaceDatabase.id;
      }
    } catch { /* The backup request repeats the check and explains a refusal. */ }
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
    if (!await confirm({ title: "Archive session?", confirmLabel: "Archive",
      message: "The session becomes read-only for everyone and is hidden from the sidebar. Its history stays viewable, and nothing is deleted. Pending approvals can't be decided while it's archived. You can unarchive it later." })) return;
    await action.run(async () => {
      await session().api(`${base()}/archive`, { method: "POST" });
      options.onChange();
    }, "Session archived");
  }
  function unarchive() {
    const current = options.session();
    if (!current || !options.manages() || action.busy() || current.status !== "archived") return;
    void action.run(async () => {
      await session().api(`${base()}/unarchive`, { method: "POST" });
      options.onChange();
    }, current.packed ? "Session unarchived, its files unpacked" : "Session unarchived");
  }
  async function pack() {
    const current = options.session();
    if (!current || !isOwner() || action.busy() || current.status !== "archived" || current.packed) return;
    if (!await confirm({ title: "Pack this session's files?", confirmLabel: "Pack files",
      message: "Its files on the host become one compressed file, to save the host's disk. Package caches and temporary files in its home folder are left out, and so are the files its clones' .gitignore ignores, such as node_modules: install them again when you need them. Clones keep their branches and uncommitted changes, and are cloned again when the session is unarchived, which unpacks the rest. The conversation stays as it is." })) return;
    await action.run(async () => {
      await session().api(`${base()}/pack`, { method: "POST" });
      options.onChange();
    }, "Session files packed");
  }
  return {
    action, backup, backups, backupsOff, backupsPending, conversationOnlyOff, backupBlocked: options.backupBlocked,
    changeVisibility: () => void changeVisibility(), createBackup: value => void createBackup(value), rename,
    archive: () => void archive(), unarchive, pack: () => void pack(),
  };
}
