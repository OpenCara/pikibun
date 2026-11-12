import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { BrowserUnavailableReason } from "../../../../../packages/shared/src/browser.js";
import type { SessionsToolRequest, SessionsToolResult } from "../../../../../packages/shared/src/cross-session.js";
import type { HostConfig } from "../../../../../packages/shared/src/host-config.js";
import type { EgressGrant } from "../../../../../packages/shared/src/network.js";
import type { HostTunnelStatus, TunnelUnavailableReason } from "../../../../../packages/shared/src/tunnel.js";
import type { GitHubIssueView, GitHubReadRequest, RunnerBinding, ScheduleToolRequest, ScheduleToolResult } from "../../../../../packages/shared/src/types.js";
import type { StoredApproval } from "../../approval-view.js";
import type { SessionWorkspace } from "../../workspace.js";
import type { ApprovalWaits } from "../approval-waits.js";
import type { HostCommandPolicy } from "../host-commands.js";
import type { SessionOperations } from "../operations.js";
import type { Metadata } from "../state.js";
import type { SessionTunnel } from "../tunnel.js";
import type { ToolCalls } from "./calls.js";

export interface ToolsConfig {
  githubRead?: (request: GitHubReadRequest) => Promise<GitHubIssueView>;
  githubWaitPollMs?: number;
  brokered?: (route: string, request: Record<string, unknown>) => Promise<unknown>;
  schedules?: (request: ScheduleToolRequest) => Promise<ScheduleToolResult>;
  crossSessions?: (request: SessionsToolRequest) => Promise<SessionsToolResult>;
  tunnels?: { status(): HostTunnelStatus | undefined };
}

export interface ToolContext {
  binding: RunnerBinding;
  config: ToolsConfig;
  sandbox: SessionWorkspace;
  onHost: boolean;
  calls: ToolCalls;
  hostCommands: HostCommandPolicy;
  waits: ApprovalWaits;
  operations: Pick<SessionOperations, "run" | "internalGitHub" | "internalBroker">;
  requireSessionTool(tool: string): Promise<void>;
  requireSenderTool(tool: string, senderId: string): Promise<void>;
  metadata(): Promise<Metadata>;
  mutate(change: (state: Metadata) => void): Promise<void>;
  authorize(actorId: string, permission: "write"): Promise<unknown>;
  hostConfig(): Promise<HostConfig>;
  programMissing(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" }, program: string): string | undefined;
  browserUnavailable(): BrowserUnavailableReason | undefined;
  tunnelUnavailable(): TunnelUnavailableReason | undefined;
  tunnel(): SessionTunnel | undefined;
  startTunnel(): SessionTunnel;
  grant(): Promise<EgressGrant>;
}

export const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
export const approvalText = (approval: StoredApproval) => text({ ...approval, admissionId: undefined, callId: undefined });
export const commandText = async (context: ToolContext, approval: StoredApproval, api: ToolExecutionApi, tool: string) =>
  text(await context.calls.shownApproval(approval, api, tool));
