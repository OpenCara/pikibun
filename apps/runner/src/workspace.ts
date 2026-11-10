import type { HostCommandOperation, Operation } from "../../../packages/shared/src/types.js";
import type { BrowseResult } from "./file-browser.js";
import type { FileContent } from "./images.js";
import type { ClonePushWorkspace } from "./push.js";
import type { CloneBackup, SandboxAuthorize, SandboxExecutionOptions, SandboxIdentity, SnapshotFile } from "./sandbox.js";
import type { SearchRequest, SearchResult } from "./search.js";
import type { FileOperationRequest, FileOperationResult } from "./file-operations.js";
import type { SessionBrowser } from "./browser-command.js";

export interface SessionWorkspace {
  readonly isolated: boolean;
  readonly home: string;
  readonly worktree: string;
  readonly hostWorktree: string;
  readonly nodeBin?: string | undefined;
  readonly browser?: SessionBrowser | undefined;
  identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>>;
  initialize(): Promise<void>;
  readFile(path: string, authorize: SandboxAuthorize): Promise<string>;
  readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent>;
  writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void>;
  importFile(directory: string, name: string, data: Buffer, authorize: SandboxAuthorize): Promise<string>;
  listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]>;
  search(request: SearchRequest, authorize: SandboxAuthorize): Promise<SearchResult>;
  fileOperation(request: FileOperationRequest, authorize: SandboxAuthorize): Promise<FileOperationResult>;
  browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult>;
  execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options?: SandboxExecutionOptions): Promise<string>;
  snapshot(authorize: SandboxAuthorize, clones?: readonly string[]): Promise<SnapshotFile[]>;
  executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

export interface IsolatedWorkspace extends SessionWorkspace, ClonePushWorkspace {
  readonly isolated: true;
  cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }>;
  cloneBackup(authorize: SandboxAuthorize): Promise<{ clones: CloneBackup[]; found: string[] }>;
  clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]>;
  cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void>;
}

export function isolatedWorkspace(workspace: SessionWorkspace): IsolatedWorkspace {
  if (!workspace.isolated) throw new Error("This step needs the sandbox, and the session runs on the host");
  return workspace as IsolatedWorkspace;
}
