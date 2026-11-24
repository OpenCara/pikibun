import { starterWorkspaceExtensions } from "./host-extensions.js";
import type { NetworkPolicy } from "./network.js";

export const workspacePresets = ["open", "balanced", "locked"] as const;
export type WorkspacePreset = (typeof workspacePresets)[number];
export const defaultWorkspacePreset: WorkspacePreset = "open";

export interface WorkspacePresetInfo {
  id: WorkspacePreset;
  title: string;
  summary: string;
  network: NetworkPolicy;
  githubReach: boolean;
  extensions: readonly string[];
}

const info: Readonly<Record<WorkspacePreset, WorkspacePresetInfo>> = Object.freeze({
  open: {
    id: "open", title: "Open",
    summary: "Ready to work: any public host, your GitHub reach on, and the starter tools with web access. For your own work and teams that trust what they run",
    network: { mode: "open", domains: [], packageRegistries: true }, githubReach: true,
    extensions: starterWorkspaceExtensions,
  },
  balanced: {
    id: "balanced", title: "Balanced",
    summary: "Package registries only on the network, your GitHub reach on, and the starter tools without third-party packages. For teams on code that shouldn't leave",
    network: { mode: "allowlist", domains: [], packageRegistries: true }, githubReach: true,
    extensions: Object.freeze(starterWorkspaceExtensions.filter(source => source.startsWith("piki:"))),
  },
  locked: {
    id: "locked", title: "Locked down",
    summary: "No network beyond the workspace's repositories, your GitHub reach off, and Git alone beside the file tools. Add what you need, one thing at a time",
    network: { mode: "off", domains: [], packageRegistries: true }, githubReach: false,
    extensions: Object.freeze(["piki:git"]),
  },
});

export function workspacePreset(id: WorkspacePreset): WorkspacePresetInfo {
  return info[id];
}

export function isWorkspacePreset(value: unknown): value is WorkspacePreset {
  return (workspacePresets as readonly unknown[]).includes(value);
}
