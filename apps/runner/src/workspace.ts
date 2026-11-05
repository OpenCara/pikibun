import type { HostCommandOperation, Operation } from "../../../packages/shared/src/types.js";
import type { BrowseResult } from "./file-browser.js";
import type { FileContent } from "./images.js";
import type { ClonePushWorkspace } from "./push.js";
import type { CloneBackup, SandboxAuthorize, SandboxExecutionOptions, SandboxIdentity, SnapshotFile } from "./sandbox.js";
import type { SearchRequest, SearchResult } from "./search.js";
import type { SessionBrowser } from "./browser-command.js";

/**
 * What a session needs from where its work lives, whatever keeps it there: the bubblewrap sandbox on Linux
 * (`Sandbox`), the host's own environment (`HostWorkspace`), and later the macOS and native Windows sandboxes. Every
 * method waits for `authorize` before it touches anything, and operations of one session run one at a time.
 */
export interface SessionWorkspace {
  /** False for the host's own environment, where only path checks confine the file tools. */
  readonly isolated: boolean;
  readonly home: string;
  /** The worktree as the session's commands see it: inside the Linux sandbox, a path that exists only there. */
  readonly worktree: string;
  /**
   * The worktree's path on the host, where the runner's own code finds it: the `cwd` of the session's Pi extensions,
   * which run in the runner. The same as `worktree` except in the Linux sandbox, which mounts it at another path.
   */
  readonly hostWorktree: string;
  /**
   * Where the session's commands find the Node.js the node tool runs, the connector's own (node-toolchain.ts): its bin
   * directory as they see it. None where it isn't given to them, and the tool then runs the Node.js on their PATH.
   */
  readonly nodeBin?: string | undefined;
  /**
   * Where the session's commands find the browser tool's driver and the host's Chromium (browser-toolchain.ts), as they
   * see them. Only the Linux sandbox has them, where the host has a Chromium: the browser runs only in the session's
   * sandbox, never on the host itself (so not in a host workspace), and the macOS and Windows sandboxes can't give it
   * yet. Without them the session isn't offered the tool.
   */
  readonly browser?: SessionBrowser | undefined;
  identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>>;
  initialize(): Promise<void>;
  readFile(path: string, authorize: SandboxAuthorize): Promise<string>;
  readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent>;
  writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void>;
  /**
   * Writes `data` as a new file named `name` in the worktree's `directory` (made where missing): a file attached to a
   * message (file-uploads.ts). Where that name is taken, the next of `report (2).pdf`, `report (3).pdf`... that isn't;
   * it never replaces a file. Answers the file's path relative to the worktree.
   */
  importFile(directory: string, name: string, data: Buffer, authorize: SandboxAuthorize): Promise<string>;
  listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]>;
  /** The search tool's search of the worktree's text files (search.ts), the same on every backend. */
  search(request: SearchRequest, authorize: SandboxAuthorize): Promise<SearchResult>;
  browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult>;
  execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options?: SandboxExecutionOptions): Promise<string>;
  /** The worktree's files, without the clones named in `clones` (an isolated workspace keeps those as bundles instead). */
  snapshot(authorize: SandboxAuthorize, clones?: readonly string[]): Promise<SnapshotFile[]>;
  /** A host command: always outside any isolation, as the connector's user. */
  executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/**
 * A workspace that confines the session: its clones are read, packed, backed up and restored by steps that run inside
 * the isolation, never by the runner reading the session's files itself.
 */
export interface IsolatedWorkspace extends SessionWorkspace, ClonePushWorkspace {
  readonly isolated: true;
  cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }>;
  cloneBackup(authorize: SandboxAuthorize): Promise<{ clones: CloneBackup[]; found: string[] }>;
  clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]>;
  cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void>;
}

/** The workspace's isolated operations; a host workspace has none, and asking for them is a caller's mistake. */
export function isolatedWorkspace(workspace: SessionWorkspace): IsolatedWorkspace {
  if (!workspace.isolated) throw new Error("This step needs the sandbox, and the session runs on the host");
  return workspace as IsolatedWorkspace;
}
