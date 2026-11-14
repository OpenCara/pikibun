import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import type {} from '../../../packages/shared/src/local-changes.js';
import { fail } from './http.js';

type Manifest = { models: LocalModelSummary[]; capabilities: ConnectorCapabilities };

export function withHostToolCapabilities(input: Record<string, unknown>, parse: (input: Record<string, unknown>) => Manifest): Manifest {
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parse(input);
  const { hostCommands, hostGrants, hostSessionGrants, ownerHostSessions, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, memberAutoApprove, approvalFree, fileBrowser, localChanges, fileUploads, directUploads, web, extensions, builtinExtensions, requiredExtensions, gitRepin, fakeIpTunnels, autoModel, ...rest } = value as Record<string, unknown>;
  if ([hostCommands, hostGrants, hostSessionGrants, ownerHostSessions, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, memberAutoApprove, approvalFree, fileBrowser, localChanges, fileUploads, directUploads, web, extensions, builtinExtensions, requiredExtensions, gitRepin, fakeIpTunnels, autoModel].some(flag => flag !== undefined && typeof flag !== 'boolean')
    || (hostGrants && !hostCommands) || (hostSessionGrants && !hostGrants) || (unboundedShellGrants && !hostGrants)
    || (requiredExtensions && !extensions)) {
    fail(400, 'invalid_manifest', 'Invalid capabilities.');
  }
  const manifest = parse({ ...input, capabilities: rest });
  return { ...manifest, capabilities: { ...manifest.capabilities, ...(hostCommands ? { hostCommands: true } : {}), ...(hostGrants ? { hostGrants: true } : {}),
    ...(hostSessionGrants ? { hostSessionGrants: true } : {}), ...(ownerHostSessions ? { ownerHostSessions: true } : {}), ...(unboundedShellGrants ? { unboundedShellGrants: true } : {}),
    ...(fileBrowser ? { fileBrowser: true } : {}), ...(localChanges ? { localChanges: true } : {}),
    ...(fileUploads ? { fileUploads: true } : {}), ...(web ? { web: true } : {}), ...(extensions ? { extensions: true } : {}),
    ...(builtinExtensions ? { builtinExtensions: true } : {}), ...(requiredExtensions ? { requiredExtensions: true } : {}), ...(fakeIpTunnels ? { fakeIpTunnels: true } : {}),
    ...(autoModel ? { autoModel: true } : {}) } };
}
