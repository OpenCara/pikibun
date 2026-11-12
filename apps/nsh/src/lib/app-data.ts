import { computed, context, effect, signal, Storage, type Accessor } from "nsh";
import {
  chatPreference, parseChatPreference, type ChatPreference, type ChatSelection, type ConnectorInfo, type SessionActivity,
  type SessionRecord, type Workspace,
} from "../shared";
import { rememberLocalSessions } from "./local-sessions";
import { createResource } from "./resource";

const LAST_CHAT_KEY = "pikibun.lastChat";

export interface LiveActivity {
  sessionId: string;
  activity: SessionActivity;
}

export interface AppData {
  sessions: Accessor<SessionRecord[]>;
  sessionsLoading: Accessor<boolean>;
  sessionsError: Accessor<string>;
  refreshSessions: () => Promise<void>;
  workspaces: Accessor<Workspace[]>;
  workspacesLoading: Accessor<boolean>;
  workspacesError: Accessor<string>;
  refreshWorkspaces: () => Promise<void>;
  lastWorkspaceId: Accessor<string>;
  setLastWorkspaceId: (id: string) => void;
  lastChat: Accessor<ChatPreference | undefined>;
  rememberChat: (host: ConnectorInfo | undefined, selection: ChatSelection, current?: Parameters<typeof chatPreference>[2]) => void;
  liveActivity: Accessor<LiveActivity | null>;
  setLiveActivity: (value: LiveActivity | null) => void;
}

export const AppDataContext = context<AppData | null>(null);

export function createAppData(): AppData {
  const liveActivity = signal<LiveActivity | null>(null);
  let working: Accessor<boolean> = () => false;
  const sessions = createResource<{ sessions: SessionRecord[] }>(() => "/api/sessions", () => (working() ? 10_000 : 30_000));
  const workspaces = createResource<{ workspaces: Workspace[] }>(() => "/api/workspaces");
  effect(() => rememberLocalSessions(sessions.data()?.sessions ?? []));
  const sorted = computed(() => [...(sessions.data()?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  working = computed(() => liveActivity()?.activity === "working"
    || sorted().some(session => session.status !== "archived" && session.activity === "working"));
  const lastWorkspaceId = signal("");
  const lastChat = signal<ChatPreference | undefined>(undefined);
  Storage.getItem(LAST_CHAT_KEY).then(raw => { if (!lastChat()) lastChat.set(parseChatPreference(raw)); }, () => undefined);
  return {
    sessions: sorted,
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
    liveActivity,
    setLiveActivity: value => liveActivity.set(value),
  };
}

export function useAppData(): AppData {
  const value = AppDataContext();
  if (!value) throw new Error("useAppData must be used inside the signed-in shell");
  return value;
}
