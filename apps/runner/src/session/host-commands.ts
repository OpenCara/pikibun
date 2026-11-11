import type { HostConfig } from "../../../../packages/shared/src/host-config.js";
import { runsOnHost, type HostCommandSession } from "../../../../packages/shared/src/host-operations.js";
import type { AuthorizationResult, HostCommandLevel, Operation, Permission } from "../../../../packages/shared/src/types.js";
import { RunnerError } from "../protocol.js";

export const HOST_COMMANDS_RULE = "runs on the host's own machine, outside the sandbox: only in sessions of the host's owner and of members they granted host "
  + "commands (Settings → Hosts → the host → Host command access), for messages of theirs. Nothing ran.";

export interface HostCommandPolicyOptions {
  ownerId: string;
  connectorOwnerId?: string;
  hostSession: boolean;
  onHost: boolean;
  limitedSandbox: boolean;
  windowsSandbox: boolean;
  testShell: boolean;
  authorize: (actorId: string, permission: Permission, host: boolean, hostSessions: boolean) => Promise<AuthorizationResult>;
  hostConfig: () => Promise<HostConfig>;
}

export class HostCommandPolicy {
  constructor(readonly options: HostCommandPolicyOptions) {}

  get session(): HostCommandSession {
    return { ownerId: this.options.ownerId, connectorOwnerId: this.options.connectorOwnerId, hostEnvironment: this.options.hostSession };
  }

  shellAllowed(): boolean {
    const { limitedSandbox, windowsSandbox, onHost, testShell } = this.options;
    return limitedSandbox || (!onHost && windowsSandbox) || onHost || testShell;
  }

  requireShell(operation: Operation, unbounded = false): void {
    if ((operation.kind === "bash" || operation.kind === "program") && !unbounded && !this.shellAllowed()) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  runsOnHost(operation: Operation, unbounded: boolean): boolean {
    return runsOnHost(operation, this.session, unbounded);
  }

  async level(actorId: string, permission: Permission): Promise<HostCommandLevel | undefined> {
    if (this.options.connectorOwnerId && actorId === this.options.connectorOwnerId) return "auto";
    const result = await this.options.authorize(actorId, permission, true, false);
    return result.hostCommands === "approve" || result.hostCommands === "auto" ? result.hostCommands : undefined;
  }

  async allowed(actorId: string): Promise<boolean> {
    for (const id of new Set([this.options.ownerId, actorId])) if (!await this.level(id, "write")) return false;
    return true;
  }

  async require(actorId: string, what: string): Promise<void> {
    if (!await this.allowed(actorId)) throw new RunnerError(403, `${what} ${HOST_COMMANDS_RULE}`);
  }

  onHostMachine(): string {
    return this.options.hostSession ? "This session runs directly on its host, so its commands run" : "This host has no resource limits for commands, so they run";
  }

  async requireHostEnvironment(): Promise<void> {
    if (!this.options.hostSession) return;
    if (this.options.connectorOwnerId === this.options.ownerId) return;
    if (!(await this.options.hostConfig()).hostSessions) {
      throw new RunnerError(403, "This host no longer runs members' sessions directly on it: its owner turned that off in Pikibun (Settings → Hosts → the host → Configuration). "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
    const result = await this.options.authorize(this.options.ownerId, "write", true, true);
    if (result.hostSessions !== true) {
      throw new RunnerError(403, "The session's owner may no longer run sessions directly on this host: the grant that let them has ended. "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
  }
}
