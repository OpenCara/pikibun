import { matching } from "../shared";
import type { IconName } from "../icons";
import { workspaceTabs, type WorkspaceTab } from "../lib/workspace-tabs";

export interface SettingsTarget {
  section: string;
  id?: string;
  tab?: WorkspaceTab;
}

export interface SearchableSection {
  id: string;
  label: string;
  icon: IconName;
  keywords?: readonly string[];
}

export interface SettingsResult {
  key: string;
  title: string;
  hint: string;
  icon: IconName;
  target: SettingsTarget;
  workspace?: { id: string; name: string };
}

export const workspaceSettings: readonly { title: string; tab: WorkspaceTab }[] = [
  { title: "Rename workspace", tab: "overview" },
  { title: "Presets", tab: "overview" },
  { title: "Setup", tab: "overview" },
  { title: "Members", tab: "overview" },
  { title: "Invite link", tab: "overview" },
  { title: "Pending members", tab: "overview" },
  { title: "Data export", tab: "overview" },
  { title: "Delete workspace", tab: "overview" },
  { title: "Repositories", tab: "sources" },
  { title: "Document sources", tab: "sources" },
  { title: "Connections", tab: "sources" },
  { title: "Push access", tab: "sources" },
  { title: "Network access", tab: "agents" },
  { title: "Your GitHub reach", tab: "agents" },
  { title: "Sub-task sessions", tab: "agents" },
  { title: "Workspace memory", tab: "agents" },
  { title: "Extensions", tab: "agents" },
  { title: "Your Auto models", tab: "agents" },
  { title: "Remote MCP servers", tab: "agents" },
  { title: "Tool groups", tab: "agents" },
  { title: "Schedules", tab: "sessions" },
  { title: "Transcripts", tab: "sessions" },
  { title: "Attachments", tab: "sessions" },
  { title: "Prompt cache", tab: "sessions" },
  { title: "Build caches", tab: "sessions" },
  { title: "Archived sessions", tab: "sessions" },
  { title: "Session database", tab: "sessions" },
];

export const MAX_SETTINGS_RESULTS = 40;

const tabLabel = (tab: WorkspaceTab) => workspaceTabs.find(item => item.value === tab)?.label ?? tab;

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type Entry = SettingsResult & { text: string };

export function searchSettings(
  query: string, sections: readonly SearchableSection[], workspaces: readonly { id: string; name: string }[], scopeOf: (section: SearchableSection) => string,
): SettingsResult[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const entries: Entry[] = [
    ...sections.map((section): Entry => ({ key: `section-${section.id}`, title: section.label, hint: scopeOf(section), icon: section.icon, target: { section: section.id },
      text: section.label })),
    ...workspaces.map((workspace): Entry => ({ key: `workspace-${workspace.id}`, title: workspace.name, hint: "Workspace", icon: "users",
      target: { section: "workspaces", id: workspace.id }, workspace, text: workspace.name })),
    ...sections.flatMap(section => (section.keywords ?? []).map((keyword): Entry => ({ key: `setting-${section.id}-${slug(keyword)}`, title: keyword, hint: section.label,
      icon: section.icon, target: { section: section.id }, text: keyword }))),
    ...workspaceSettings.flatMap(setting => workspaces.map((workspace): Entry => ({
      key: `workspace-setting-${workspace.id}-${slug(setting.title)}`, title: setting.title, hint: `${workspace.name} · ${tabLabel(setting.tab)}`, icon: "users",
      target: { section: "workspaces", id: workspace.id, tab: setting.tab }, workspace, text: `${setting.title} ${workspace.name}`,
    }))),
  ];
  const named = entries.filter(entry => words.some(word => entry.title.toLowerCase().includes(word)));
  return matching(query, named, entry => entry.text).slice(0, MAX_SETTINGS_RESULTS).map(({ text: _text, ...result }) => result);
}
