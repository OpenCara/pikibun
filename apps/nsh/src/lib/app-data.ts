import { computed, context, effect, signal, Storage, untracked, type Accessor } from "nsh";
import {
  chatPreference, parseChatPreference, segment, type ChatPreference, type ChatSelection, type ConnectorInfo, type SessionActivity,
  type SessionRecord, type Workspace,
} from "../shared";
import { session } from "./auth";
import { rememberLocalSessions } from "./local-sessions";
import { createResource } from "./resource";
import { orderWorkspaces } from "./workspace-order";

const LAST_CHAT_KEY = "pikibun.lastChat";
const LAST_AUTO_KEY = "pikibun.lastAuto";
const SANDBOXED_HOSTS_KEY = "pikibun.sandboxedHosts";
const SANDBOXED_HOSTS_KEPT = 50;
const ON_HOST_HOSTS_KEY = "pikibun.onHostHosts";

export type EnvironmentChoice = "host" | "sandbox";

function parseSandboxedHosts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200).slice(0, SANDBOXED_HOSTS_KEPT) : [];
  } catch {
    return [];
  }
}

export interface AutoPreference {
  host: boolean;
  model: boolean;
}

const noAuto: AutoPreference = { host: false, model: false };

function parseAutoPreference(raw: string | null | undefined): AutoPreference | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AutoPreference> | null;
    return value && typeof value === "object" ? { host: value.host === true, model: value.model === true } : undefined;
  } catch {
    return undefined;
  }
}

export interface LiveActivity {
  sessionId: string;
  activity: SessionActivity;
}

export interface SideAskRequest {
  sessionId: string;
  conversationId: string | null;
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
  reorderWorkspaces: (ids: readonly string[]) => Promise<void>;
  hideWorkspace: (id: string, hidden: boolean) => Promise<void>;
  lastWorkspaceId: Accessor<string>;
  setLastWorkspaceId: (id: string) => void;
  lastChat: Accessor<ChatPreference | undefined>;
  rememberChat: (host: ConnectorInfo | undefined, selection: ChatSelection, current?: Parameters<typeof chatPreference>[2]) => void;
  lastAuto: Accessor<AutoPreference>;
  rememberAuto: (value: AutoPreference) => void;
  environmentChosen: (hostId: string | undefined) => EnvironmentChoice | undefined;
  rememberEnvironment: (hostId: string, onHost: boolean, foreign: boolean) => void;
  liveActivity: Accessor<LiveActivity | null>;
  setLiveActivity: (value: LiveActivity | null) => void;
  sideAskRequest: Accessor<SideAskRequest | null>;
  requestSideAsk: (value: SideAskRequest | null) => void;
}

export const AppDataContext = context<AppData | null>(null);

export function createAppData(): AppData {
  const liveActivity = signal<LiveActivity | null>(null);
  const sideAskRequest = signal<SideAskRequest | null>(null);
  let working: Accessor<boolean> = () => false;
  const sessions = createResource<{ sessions: SessionRecord[] }>(() => "/api/sessions", () => (working() ? 10_000 : 30_000));
  const workspaces = createResource<{ workspaces: Workspace[] }>(() => "/api/workspaces");
  const pendingOrder = signal<readonly string[] | null>(null);
  const pendingHidden = signal<Readonly<Record<string, boolean>>>({});
  const listedWorkspaces = computed(() => {
    const list = workspaces.data()?.workspaces ?? [];
    const order = pendingOrder();
    const ordered = order ? orderWorkspaces(list, order) : list;
    const hiding = pendingHidden();
    return Object.keys(hiding).length ? ordered.map(item => (item.id in hiding ? { ...item, hidden: hiding[item.id] } : item)) : ordered;
  });
  let writes = 0;
  let writing: Promise<unknown> = Promise.resolve();
  effect(() => rememberLocalSessions(sessions.data()?.sessions ?? []));
  const sorted = computed(() => [...(sessions.data()?.sessions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  working = computed(() => liveActivity()?.activity === "working"
    || sorted().some(session => session.status !== "archived" && session.activity === "working"));
  const lastWorkspaceId = signal("");
  async function writeWorkspaces(path: string, body: Record<string, unknown>): Promise<void> {
    const write = ++writes;
    const settle = () => { pendingOrder.set(null); pendingHidden.set({}); };
    const sent = writing.then(() => untracked(session).api<{ workspaces: Workspace[] }>(path, { method: "PUT", body }));
    writing = sent.catch(() => undefined);
    try {
      const result = await sent;
      if (write !== writes) return;
      workspaces.replace(result);
      settle();
    } catch (reason) {
      if (write !== writes) return;
      settle();
      void workspaces.refresh();
      throw reason;
    }
  }
  const lastChat = signal<ChatPreference | undefined>(undefined);
  Storage.getItem(LAST_CHAT_KEY).then(raw => { if (!lastChat()) lastChat.set(parseChatPreference(raw)); }, () => undefined);
  const lastAuto = signal<AutoPreference | undefined>(undefined);
  Storage.getItem(LAST_AUTO_KEY).then(raw => { if (!lastAuto()) lastAuto.set(parseAutoPreference(raw)); }, () => undefined);
  const sandboxedHosts = signal<string[] | undefined>(undefined);
  Storage.getItem(SANDBOXED_HOSTS_KEY).then(raw => { if (!sandboxedHosts()) sandboxedHosts.set(parseSandboxedHosts(raw)); }, () => undefined);
  const onHostHosts = signal<string[] | undefined>(undefined);
  Storage.getItem(ON_HOST_HOSTS_KEY).then(raw => { if (!onHostHosts()) onHostHosts.set(parseSandboxedHosts(raw)); }, () => undefined);
  return {
    sessions: sorted,
    sessionsLoading: () => sessions.loading() && !sessions.data(),
    sessionsError: sessions.error,
    refreshSessions: sessions.refresh,
    workspaces: listedWorkspaces,
    workspacesLoading: () => workspaces.loading() && !workspaces.data(),
    workspacesError: workspaces.error,
    refreshWorkspaces: workspaces.refresh,
    reorderWorkspaces(ids) {
      pendingOrder.set([...ids]);
      return writeWorkspaces("/api/workspaces/order", { workspaceIds: ids });
    },
    hideWorkspace(id, hidden) {
      pendingHidden.update(current => ({ ...current, [id]: hidden }));
      return writeWorkspaces(`/api/workspaces/${segment(id)}/hidden`, { hidden });
    },
    lastWorkspaceId,
    setLastWorkspaceId: id => lastWorkspaceId.set(id),
    lastChat,
    rememberChat(host, selection, current) {
      const preference = chatPreference(host, selection, current);
      if (!preference) return;
      lastChat.set(preference);
      Storage.setItem(LAST_CHAT_KEY, JSON.stringify(preference)).catch(() => undefined);
    },
    lastAuto: () => lastAuto() ?? noAuto,
    rememberAuto(value) {
      lastAuto.set(value);
      Storage.setItem(LAST_AUTO_KEY, JSON.stringify(value)).catch(() => undefined);
    },
    environmentChosen: hostId => !hostId ? undefined : sandboxedHosts()?.includes(hostId) ? "sandbox" : onHostHosts()?.includes(hostId) ? "host" : undefined,
    rememberEnvironment(hostId, onHost, foreign) {
      const update = (list: typeof sandboxedHosts, key: string, add: boolean) => {
        const others = (list() ?? []).filter(id => id !== hostId);
        const next = add ? [hostId, ...others].slice(0, SANDBOXED_HOSTS_KEPT) : others;
        list.set(next);
        Storage.setItem(key, JSON.stringify(next)).catch(() => undefined);
      };
      update(sandboxedHosts, SANDBOXED_HOSTS_KEY, !onHost);
      update(onHostHosts, ON_HOST_HOSTS_KEY, onHost && foreign);
    },
    liveActivity,
    setLiveActivity: value => liveActivity.set(value),
    sideAskRequest,
    requestSideAsk: value => sideAskRequest.set(value),
  };
}

export function useAppData(): AppData {
  const value = AppDataContext();
  if (!value) throw new Error("useAppData must be used inside the signed-in shell");
  return value;
}
