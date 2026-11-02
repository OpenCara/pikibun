import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { fail } from './http.js';

type Manifest = { models: LocalModelSummary[]; capabilities: ConnectorCapabilities };

/**
 * Validates the capability of connectors that carry host_bash (`hostCommands`), that honor host command grants
 * (`hostGrants`), that run sessions on the host for members granted that (`hostSessionGrants`), that run the sandboxed
 * commands of members granted host commands without the resource limits the host lacks (`unboundedShellGrants`), that
 * let their owner decide host commands without approve permission on the session (`hostOwnerDecides`), that run GitHub
 * effects under Auto-approve (`automaticGitHub`), that run the requests of members a session's owner auto-approves
 * without asking (`requesterAutoApprove`), that browse a session's worktree for the session panel
 * (`fileBrowser`), that take files attached to messages (`fileUploads`), also from the desktop app beside them
 * (`directUploads`), that carried the retired web tools (`web`), that run extensions (`extensions`) and the Pi built-in ones
 * their configuration turns on (`builtinExtensions`), and leaves every other manifest field to `parse`, which still rejects unknown ones. An absent flag
 * stays absent, as from older connectors, so nothing is offered on hosts that can't do it. `gitRepin`, from connectors
 * of when sessions pinned their repositories, is accepted and dropped.
 */
export function withHostToolCapabilities(input: Record<string, unknown>, parse: (input: Record<string, unknown>) => Manifest): Manifest {
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parse(input);
  const { hostCommands, hostGrants, hostSessionGrants, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, fileBrowser, fileUploads, directUploads, web, extensions, builtinExtensions, gitRepin, ...rest } = value as Record<string, unknown>;
  if ([hostCommands, hostGrants, hostSessionGrants, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, fileBrowser, fileUploads, directUploads, web, extensions, builtinExtensions, gitRepin].some(flag => flag !== undefined && typeof flag !== 'boolean')
    || (hostGrants && !hostCommands) || (hostSessionGrants && !hostGrants) || (unboundedShellGrants && !hostGrants) || (hostOwnerDecides && !hostCommands) || (directUploads && !fileUploads)) {
    fail(400, 'invalid_manifest', 'Invalid capabilities.');
  }
  const manifest = parse({ ...input, capabilities: rest });
  return { ...manifest, capabilities: { ...manifest.capabilities, ...(hostCommands ? { hostCommands: true } : {}), ...(hostGrants ? { hostGrants: true } : {}),
    ...(hostSessionGrants ? { hostSessionGrants: true } : {}), ...(unboundedShellGrants ? { unboundedShellGrants: true } : {}),
    ...(hostOwnerDecides ? { hostOwnerDecides: true } : {}), ...(automaticGitHub ? { automaticGitHub: true } : {}), ...(requesterAutoApprove ? { requesterAutoApprove: true } : {}), ...(fileBrowser ? { fileBrowser: true } : {}),
    ...(fileUploads ? { fileUploads: true } : {}), ...(directUploads ? { directUploads: true } : {}), ...(web ? { web: true } : {}), ...(extensions ? { extensions: true } : {}),
    ...(builtinExtensions ? { builtinExtensions: true } : {}) } };
}
