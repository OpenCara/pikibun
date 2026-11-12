import { browserUnavailableReason, type BrowserUnavailableReason, type HostBrowserStatus } from "../../../../packages/shared/src/browser.js";
import type { WorkspaceExtensionsAnswer } from "../../../../packages/shared/src/host-extensions.js";
import { documentKindsOff, extensionSwitchOn, sessionToolExtensions, sessionToolsOff } from "../../../../packages/shared/src/piki-extensions.js";
import { programInstallStep } from "../../../../packages/shared/src/program-install.js";
import type { DocumentKind } from "../../../../packages/shared/src/sources.js";
import type { ProgramToolDefinition, ToolDefinition } from "../../../../packages/shared/src/tool-definitions.js";
import { unknownToolGroup, type MemberToolGroup } from "../../../../packages/shared/src/tool-groups.js";
import { tunnelUnavailableReason, type HostTunnelStatus, type TunnelUnavailableReason } from "../../../../packages/shared/src/tunnel.js";
import type { RunnerBinding } from "../../../../packages/shared/src/types.js";
import { sandboxMissingPrograms } from "../program-availability.js";
import { RunnerError } from "../protocol.js";
import { pythonPrograms } from "../python-command.js";
import type { SandboxBackendConfig } from "../sandbox-backend.js";
import { Sandbox } from "../sandbox.js";
import type { SessionWorkspace } from "../workspace.js";

export interface ToolAvailabilityOptions {
  binding: RunnerBinding;
  config: {
    extensions?: { workspace(workspaceId: string): Promise<WorkspaceExtensionsAnswer>; lastKnown?(workspaceId: string): WorkspaceExtensionsAnswer | undefined };
    sandboxBackend?: SandboxBackendConfig;
    browserStatus?: () => HostBrowserStatus | undefined;
    tunnels?: { status(): HostTunnelStatus | undefined };
  };
  sandbox: SessionWorkspace;
  onHost: boolean;
  definitions(): readonly ToolDefinition[];
  toolNames(): string[];
}

export class ToolAvailability {
  constructor(private readonly options: ToolAvailabilityOptions) {}

  browserUnavailable(): BrowserUnavailableReason | undefined {
    const { config, onHost, sandbox } = this.options;
    if (sandbox.browser) return undefined;
    if (onHost) return "on-host";
    if (config.sandboxBackend) return "sandbox";
    const status = config.browserStatus?.();
    if (!status) return undefined;
    return browserUnavailableReason(status.state) ?? "missing";
  }

  tunnelUnavailable(): TunnelUnavailableReason | undefined {
    const { config, onHost, sandbox } = this.options;
    if (!config.tunnels) return undefined;
    if (onHost) return "on-host";
    if (config.sandboxBackend || !(sandbox instanceof Sandbox)) return "sandbox";
    const status = config.tunnels.status();
    return status ? tunnelUnavailableReason(status.state) : "missing";
  }

  linuxSandbox(): Sandbox | undefined {
    const { config, onHost, sandbox } = this.options;
    return !onHost && !config.sandboxBackend && sandbox instanceof Sandbox ? sandbox : undefined;
  }

  missingPrograms(off: ReadonlySet<string>): { tool: string; source: string; programs: string[] }[] {
    const sandbox = this.linuxSandbox();
    if (!sandbox) return [];
    const node = sandbox.nodePrograms;
    const tools = [
      ...this.options.definitions().filter((definition): definition is ProgramToolDefinition => definition.kind === "program" && !off.has(definition.name))
        .map(definition => ({ tool: definition.name, source: definition.extensions[0] ?? `piki:${definition.name}`, programs: sandboxMissingPrograms(definition, node) })),
      ...(this.options.toolNames().includes("python") && !off.has("python")
        ? [{ tool: "python", source: "piki:python", programs: sandboxMissingPrograms({ programs: pythonPrograms, path: "/usr/local/bin" }) }] : []),
    ];
    return tools.filter(item => item.programs.length);
  }

  programMissing(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" }, program: string): string | undefined {
    const sandbox = this.linuxSandbox();
    if (!sandbox || !sandboxMissingPrograms({ ...tool, programs: [program] }, sandbox.nodePrograms).length) return undefined;
    return `${program} isn't installed on this host where the session's sandbox sees it, so the call would fail with "command not found". `
      + `The host's owner installs it for the whole system, as the sandbox sees only the host's /usr: ${programInstallStep(program) ?? "the distribution's package"}. `
      + "Tell the user so, and use what this session has meanwhile where you can.";
  }

  tunnelOffered(): boolean {
    return !!this.options.config.tunnels && this.tunnelUnavailable() === undefined;
  }

  definedToolsOff(off: Set<string>, extensions: Parameters<typeof sessionToolsOff>[0]): Set<string> {
    for (const definition of this.options.definitions()) {
      off.delete(definition.name);
      if (!definition.extensions.some(extension => extensionSwitchOn(extension, extensions))) off.add(definition.name);
    }
    return off;
  }

  async sessionToolsOff(senderId?: string): Promise<Set<string>> {
    const { binding } = this.options;
    const config = this.options.config.extensions;
    const workspaceId = binding.session.workspaceId;
    const answer = config ? await config.workspace(workspaceId).catch(() => undefined) : undefined;
    const extensions = answer?.extensions ?? [];
    const off = this.definedToolsOff(sessionToolsOff(extensions), extensions);
    for (const tool of (await this.memberToolGroup(binding.owner.id))?.off ?? []) off.add(tool);
    if (senderId !== undefined && senderId !== binding.owner.id) {
      for (const tool of (await this.memberToolGroup(senderId))?.off ?? []) off.add(tool);
    }
    if (!config) return off;
    const last = config.lastKnown?.(workspaceId);
    if (last) for (const tool of sessionToolsOff(last.extensions, { failClosedOnly: true })) off.add(tool);
    return off;
  }

  async memberToolGroup(userId: string): Promise<MemberToolGroup | undefined> {
    const config = this.options.config.extensions;
    if (!config) return undefined;
    const workspaceId = this.options.binding.session.workspaceId;
    const answer = await config.workspace(workspaceId).catch(() => undefined);
    if (!config.lastKnown) return answer?.toolGroups?.[userId];
    const last = config.lastKnown(workspaceId);
    return last ? last.toolGroups?.[userId] : unknownToolGroup;
  }

  async requireSenderTool(tool: string, senderId: string): Promise<void> {
    if (senderId === this.options.binding.owner.id) return;
    const group = await this.memberToolGroup(senderId);
    if (!group?.off.includes(tool)) return;
    throw new RunnerError(403, `${tool} isn't among the tools of the person who sent this message (${group.name}): a message runs only the tools both its sender and the session's owner have. Workspace owners and admins choose each member's tools under Settings → Workspaces → Tool groups. Nothing ran.`);
  }

  async documentKindsOff(): Promise<Set<DocumentKind>> {
    const config = this.options.config.extensions;
    if (!config) return new Set();
    const answer = await config.workspace(this.options.binding.session.workspaceId).catch(() => undefined);
    return answer ? documentKindsOff(answer.extensions) : new Set();
  }

  async requireSessionTool(tool: string): Promise<void> {
    if (!(await this.sessionToolsOff()).has(tool)) return;
    const group = await this.memberToolGroup(this.options.binding.owner.id);
    if (group?.off.includes(tool)) {
      throw new RunnerError(403, `${tool} isn't among the tools of this session's owner (${group.name}). Workspace owners and admins choose each member's tools under Settings → Workspaces → Tool groups. Nothing ran.`);
    }
    const defined = this.options.definitions().find(item => item.name === tool);
    const extensions = defined ? [...defined.extensions] : sessionToolExtensions(tool).map(item => item.source);
    throw new RunnerError(403, `${tool} is turned off in this workspace${extensions.length ? ` (${extensions.join(", ")})` : ""}. Its owners and admins add it under Settings → Workspaces → Extensions.`);
  }
}
