import { signal } from "nsh";

export type WorkspaceTab = "overview" | "sources" | "agents" | "sessions";

export const workspaceTabs: readonly { value: WorkspaceTab; label: string; hint: string }[] = [
  { value: "overview", label: "Overview", hint: "Its name, its people and its data" },
  { value: "sources", label: "Sources", hint: "What sessions work on, and how they push" },
  { value: "agents", label: "Agents", hint: "What agents can use and reach: extensions, tools, the network and GitHub" },
  { value: "sessions", label: "Sessions", hint: "How sessions run and are kept: schedules, transcripts, caches and storage" },
];

export const wantedWorkspaceTab = signal<{ workspaceId: string; tab: WorkspaceTab } | null>(null);

export function showWorkspaceTab(workspaceId: string, tab: WorkspaceTab): void {
  wantedWorkspaceTab.set({ workspaceId, tab });
}
