import { computed, context, signal, Storage, type Accessor } from "nsh";
import {
  AUTO_APPROVE_CONFIRMED_KEY, chatPreference, parseChatPreference, type ChatPreference, type ChatSelection, type ConnectorInfo, type SessionActivity,
  type SessionRecord, type Workspace,
} from "../shared";
import { createResource } from "./resource";

/** The model and reasoning last chatted with on this device; new chats start from them. */
const LAST_CHAT_KEY = "pikibun.lastChat";

/** What the open session's live view says its agent is doing; fresher than the list's last fetch. */
export interface LiveActivity {
  sessionId: string;
  activity: SessionActivity;
}

export interface AppData {
  /** Every session the user can read, newest first. */
  sessions: Accessor<SessionRecord[]>;
  sessionsLoading: Accessor<boolean>;
  sessionsError: Accessor<string>;
  /** Reloads the list; resolves once it has. */
  refreshSessions: () => Promise<void>;
  workspaces: Accessor<Workspace[]>;
  workspacesLoading: Accessor<boolean>;
  workspacesError: Accessor<string>;
  refreshWorkspaces: () => Promise<void>;
  /** The workspace the last session was started in; new sessions default to it. */
  lastWorkspaceId: Accessor<string>;
  setLastWorkspaceId: (id: string) => void;
  lastChat: Accessor<ChatPreference | undefined>;
  rememberChat: (host: ConnectorInfo | undefined, selection: ChatSelection, current?: Parameters<typeof chatPreference>[2]) => void;
  /** Whether the user confirmed, on this device, the Auto-approve warning that names merges. */
  autoApproveConfirmed: Accessor<boolean>;
  rememberAutoApproveConfirmed: () => void;
  liveActivity: Accessor<LiveActivity | null>;
  setLiveActivity: (value: LiveActivity | null) => void;
}

export const AppDataContext = context<AppData | null>(null);

/** The lists shared by the session list, the session view and the new-session form. Create it while signed in. */
export function createAppData(): AppData {
  const liveActivity = signal<LiveActivity | null>(null);
  // Kept current like the web sidebar, sooner while an agent is at work, here or as last listed. The interval reads
  // `working` lazily (it is a computed of the list itself), and changes only when whether anything works changes.
  let working: Accessor<boolean> = () => false;
  const sessions = createResource<{ sessions: SessionRecord[] }>(() => "/api/sessions", () => (working() ? 10_000 : 30_000));
  const workspaces = createResource<{ workspaces: Workspace[] }>(() => "/api/workspaces");
  const sorted = computed(() => [...(sessions.data()?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  working = computed(() => liveActivity()?.activity === "working"
    || sorted().some(session => session.status !== "archived" && session.activity === "working"));
  const lastWorkspaceId = signal("");
  const lastChat = signal<ChatPreference | undefined>(undefined);
  const autoApproveConfirmed = signal(false);
  // A choice made before the stored one loads is newer, so it wins.
  Storage.getItem(LAST_CHAT_KEY).then(raw => { if (!lastChat()) lastChat.set(parseChatPreference(raw)); }, () => undefined);
  Storage.getItem(AUTO_APPROVE_CONFIRMED_KEY).then(raw => { if (raw === "1") autoApproveConfirmed.set(true); }, () => undefined);
  return {
    sessions: sorted,
    // Keep the previous list visible while a background refresh is in flight.
    sessionsLoading: () => sessions.loading() && !sessions.data(),
    sessionsError: sessions.error,
    refreshSessions: sessions.refresh,
    workspaces: () => workspaces.data()?.workspaces ?? [],
    workspacesLoading: () => workspaces.loading() && !workspaces.data(),
    workspacesError: workspaces.error,
    refreshWorkspaces: workspaces.refresh,
    lastWorkspaceId,
    setLastWorkspaceId: id => lastWorkspaceId.set(id),
    lastChat,
    rememberChat(host, selection, current) {
      const preference = chatPreference(host, selection, current);
      if (!preference) return;
      lastChat.set(preference);
      Storage.setItem(LAST_CHAT_KEY, JSON.stringify(preference)).catch(() => undefined);
    },
    autoApproveConfirmed,
    rememberAutoApproveConfirmed() {
      autoApproveConfirmed.set(true);
      Storage.setItem(AUTO_APPROVE_CONFIRMED_KEY, "1").catch(() => undefined);
    },
    liveActivity,
    setLiveActivity: value => liveActivity.set(value),
  };
}

/** The app data of the signed-in shell. */
export function useAppData(): AppData {
  const value = AppDataContext();
  if (!value) throw new Error("useAppData must be used inside the signed-in shell");
  return value;
}
