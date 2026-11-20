import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import type {} from '../../../packages/shared/src/local-changes.js';
import { fail } from './http.js';

type Manifest = { models: LocalModelSummary[]; capabilities: ConnectorCapabilities };

export function withHostToolCapabilities(input: Record<string, unknown>, parse: (input: Record<string, unknown>) => Manifest): Manifest {
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parse(input);
  const { hostCommands, hostGrants, hostSessionGrants, ownerHostSessions, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, memberAutoApprove, approvalFree, fileBrowser, localChanges, fileUploads, directUploads, web, extensions, builtinExtensions, requiredExtensions, gitSubdirectories, modelCalls, gitRepin, fakeIpTunnels, autoModel, sessionTitles, portableSessions, artifacts, sessionResources, privateSessions, ...rest } = value as Record<string, unknown>;
  if ([hostCommands, hostGrants, hostSessionGrants, ownerHostSessions, unboundedShellGrants, hostOwnerDecides, automaticGitHub, requesterAutoApprove, memberAutoApprove, approvalFree, fileBrowser, localChanges, fileUploads, directUploads, web, extensions, builtinExtensions, requiredExtensions, gitSubdirectories, modelCalls, gitRepin, fakeIpTunnels, autoModel, sessionTitles, portableSessions, artifacts, sessionResources].some(flag => flag !== undefined && typeof flag !== 'boolean')
    || (hostGrants && !hostCommands) || (hostSessionGrants && !hostGrants) || (unboundedShellGrants && !hostGrants)
    || (requiredExtensions && !extensions)
    || (privateSessions !== undefined && (typeof privateSessions !== 'number' || !Number.isInteger(privateSessions) || privateSessions < 1 || privateSessions > 1000))) {
    fail(400, 'invalid_manifest', 'Invalid capabilities.');
  }
  const manifest = parse({ ...input, capabilities: rest });
  return { ...manifest, capabilities: { ...manifest.capabilities, ...(hostCommands ? { hostCommands: true } : {}), ...(hostGrants ? { hostGrants: true } : {}),
    ...(hostSessionGrants ? { hostSessionGrants: true } : {}), ...(ownerHostSessions ? { ownerHostSessions: true } : {}), ...(unboundedShellGrants ? { unboundedShellGrants: true } : {}),
    ...(fileBrowser ? { fileBrowser: true } : {}), ...(localChanges ? { localChanges: true } : {}),
    ...(fileUploads ? { fileUploads: true } : {}), ...(web ? { web: true } : {}), ...(extensions ? { extensions: true } : {}),
    ...(builtinExtensions ? { builtinExtensions: true } : {}), ...(requiredExtensions ? { requiredExtensions: true } : {}), ...(gitSubdirectories ? { gitSubdirectories: true } : {}), ...(modelCalls ? { modelCalls: true } : {}), ...(fakeIpTunnels ? { fakeIpTunnels: true } : {}),
    ...(autoModel ? { autoModel: true } : {}), ...(sessionTitles ? { sessionTitles: true } : {}), ...(portableSessions ? { portableSessions: true } : {}), ...(artifacts ? { artifacts: true } : {}), ...(sessionResources ? { sessionResources: true } : {}),
    ...(typeof privateSessions === 'number' ? { privateSessions } : {}) } };
}
