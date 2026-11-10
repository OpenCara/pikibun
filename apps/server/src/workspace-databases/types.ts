import type { WorkspaceDatabaseTls } from '../../../../packages/shared/src/types.js';

export interface WorkspaceDatabaseTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: WorkspaceDatabaseTls;
  caCertificate: string | null;
}

export interface WorkspaceBackupSave {
  workspace: { id: string; name: string; ownerId: string };
  session: {
    id: string; workspaceId: string; ownerId: string; title: string; status: string; visibility: string; createdAt: string;
    record: unknown;
  };
  backup: { id: string; format: string; sha256: string; size: number; createdAt: string };
  snapshot: Uint8Array;
}

export interface WorkspaceBackupRef {
  id: string;
  sessionId: string;
  size: number;
}

export interface ImportedSession {
  id: string; ownerId: string; title: string; status: string; visibility: string; createdAt: string;
  record: Record<string, unknown>;
  data: Record<string, unknown> | null;
}

export interface ImportedAuditEntry {
  id: string;
  sessionId: string | null;
  actorId: string | null;
  action: string;
  detail: unknown;
  createdAt: string;
}

export interface WorkspaceImport {
  workspace: { id: string; name: string; ownerId: string };
  exportedAt: string;
  workspaceData: Record<string, unknown> | null;
  sessions: ImportedSession[];
  audit: ImportedAuditEntry[];
}

export const workspaceDatabaseFailures = [
  'host_not_allowed', 'host_not_found', 'tls_not_allowed', 'unreachable', 'tls_failed', 'authentication_failed',
  'database_not_found', 'permission_denied', 'pikibun_database', 'schema_mismatch', 'response_too_large', 'unavailable',
] as const;
export type WorkspaceDatabaseFailure = (typeof workspaceDatabaseFailures)[number];

export class WorkspaceDatabaseError extends Error {
  readonly failure: WorkspaceDatabaseFailure;

  constructor(failure: WorkspaceDatabaseFailure, options?: ErrorOptions) {
    super(`Workspace database operation failed: ${failure}`, options);
    this.name = 'WorkspaceDatabaseError';
    this.failure = failure;
  }
}

export interface WorkspaceDatabaseProvider {
  readonly privateHosts: boolean;
  verify(target: WorkspaceDatabaseTarget): Promise<void>;
  save(target: WorkspaceDatabaseTarget, save: WorkspaceBackupSave): Promise<void>;
  load(target: WorkspaceDatabaseTarget, backup: WorkspaceBackupRef): Promise<Uint8Array | null>;
  import(target: WorkspaceDatabaseTarget, data: WorkspaceImport): Promise<void>;
}
