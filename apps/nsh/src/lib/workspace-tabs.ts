import { signal } from "nsh";

export type WorkspaceTab = "overview" | "sources" | "agents" | "sessions";

export const workspaceTabs: readonly { value: WorkspaceTab; label: string; hint: string }[] = [
  { value: "overview", label: "Overview", hint: "Its name, its people and its data" },
  { value: "sources", label: "Sources", hint: "What sessions work on, and how they push" },
  { value: "agents", label: "Agents", hint: "What agents can use and reach: extensions, tools, the network and GitHub" },
  { value: "sessions", label: "Sessions", hint: "How sessions run and are kept: schedules, transcripts, caches and storage" },
];

const WANTED_FOR_MS = 10_000;

const wanted = signal<{ workspaceId: string; tab: WorkspaceTab; at: number } | null>(null);

export function showWorkspaceTab(workspaceId: string, tab: WorkspaceTab): void {
  wanted.set({ workspaceId, tab, at: Date.now() });
}

export function forgetWorkspaceTab(): void {
  wanted.set(null);
}

export function takeWorkspaceTab(workspaceId: string): WorkspaceTab | null {
  const request = wanted();
  if (!request) return null;
  const fresh = Date.now() - request.at <= WANTED_FOR_MS;
  if (fresh && request.workspaceId !== workspaceId) return null;
  wanted.set(null);
  return fresh ? request.tab : null;
}
