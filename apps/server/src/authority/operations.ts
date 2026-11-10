import { programToolNames } from '../../../../packages/shared/src/types.js';
import { bundledToolDefinitions } from '../../../../packages/shared/src/tool-definitions.js';
import { validExtensionToolOperation, validHostOperation } from '../../../../packages/shared/src/host-operations.js';
import type { GitHubMergeMethod, Operation, PermissionNeed, PullRequestRequest } from '../../../../packages/shared/src/types.js';
import { GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, githubMergeMethods, permissionNeeds, toolNames } from '../../../../packages/shared/src/types.js';
import { validCloneDirectory, validPushBranch, validPushTag } from '../../../../packages/shared/src/repositories.js';
import { fail, text } from '../http.js';

const programTools: ReadonlySet<string> = new Set([...programToolNames, ...bundledToolDefinitions.filter(item => item.kind === 'program').map(item => item.name)]);
const knownTools: ReadonlySet<string> = new Set([...toolNames, ...bundledToolDefinitions.map(item => item.name)]);

export function validRepositoryPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,63}$/.test(value)
    && !value.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()));
}

function pullRequest(value: unknown): PullRequestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_operation', 'Invalid pull request.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['title', 'body', 'base', 'draft'].includes(key))) fail(400, 'invalid_operation', 'Invalid pull request.');
  const title = text(input.title, 'pull request title', 256);
  if (!title.trim() || /[\r\n]/.test(title)) fail(400, 'invalid_operation', 'Invalid pull request title.');
  const body = text(input.body, 'pull request body', 60000, 0);
  if (input.base !== undefined && !validPushBranch(input.base)) fail(400, 'invalid_operation', 'Invalid pull request base branch.');
  if (input.draft !== undefined && typeof input.draft !== 'boolean') fail(400, 'invalid_operation', 'Invalid pull request draft flag.');
  return { title, body, ...(input.base === undefined ? {} : { base: input.base as string }),
    ...(input.draft === undefined ? {} : { draft: input.draft as boolean }) };
}

export function githubRepositoryName(value: unknown): string {
  const repository = text(value, 'repository', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    fail(400, 'invalid_operation', 'Expected a GitHub owner/repository, not a URL.');
  }
  return repository;
}
export function issueNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(400, 'invalid_operation', 'Invalid issue number.');
  return Number(value);
}

export function parseOperation(input: unknown): Operation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_operation', 'Expected an operation.');
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case 'host.bash':
    case 'git.repin':
      if (!validHostOperation(input)) fail(400, 'invalid_operation', 'Invalid host command or repin request.');
      return input.kind === 'host.bash'
        ? { kind: input.kind, command: input.command, timeoutSeconds: input.timeoutSeconds }
        : { kind: input.kind, repository: input.repository, ref: input.ref };
    case 'extension.tool':
      if (!validExtensionToolOperation(input)) fail(400, 'invalid_operation', 'Invalid extension tool call.');
      return { kind: input.kind, source: input.source, tool: input.tool, arguments: input.arguments, digest: input.digest };
    case 'git.commit': return { kind: value.kind, message: text(value.message, 'commit message', 4000) };
    case 'bash': return { kind: value.kind, command: text(value.command, 'command', 8192) };
    case 'program':
      if (Object.keys(value).length !== 3 || typeof value.tool !== 'string' || !programTools.has(value.tool)) fail(400, 'invalid_operation', 'Unknown program tool.');
      return { kind: value.kind, tool: value.tool, command: text(value.command, 'command', 8192) };
    case 'github.comment':
      return { kind: value.kind, repository: githubRepositoryName(value.repository), issue: issueNumber(value.issue), body: text(value.body, 'comment body', 60000) };
    case 'github.merge': {
      const repository = githubRepositoryName(value.repository);
      if (!Number.isSafeInteger(value.pull) || Number(value.pull) < 1) fail(400, 'invalid_operation', 'Invalid pull request number.');
      if (typeof value.sha !== 'string' || !/^[0-9a-f]{40}$/.test(value.sha)) fail(400, 'invalid_operation', 'Expected the 40-character head commit to merge.');
      if (!githubMergeMethods.includes(value.method as GitHubMergeMethod)) fail(400, 'invalid_operation', 'Expected the merge, squash or rebase method.');
      return { kind: value.kind, repository, pull: Number(value.pull), sha: value.sha, method: value.method as GitHubMergeMethod };
    }
    case 'github.issue': {
      const repository = githubRepositoryName(value.repository);
      const title = text(value.title, 'issue title', GITHUB_ISSUE_TITLE_LIMIT);
      if (!title.trim() || /[\r\n]/.test(title)) fail(400, 'invalid_operation', 'Expected a one-line issue title.');
      return { kind: value.kind, repository, title, body: text(value.body, 'issue body', GITHUB_ISSUE_BODY_LIMIT, 0) };
    }
    case 'git.push': {
      if (!validRepositoryPath(value.repository)) fail(400, 'invalid_operation', 'Expected a pinned repository path.');
      if (!validPushBranch(value.branch)) fail(400, 'invalid_operation', 'Invalid branch name.');
      if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) fail(400, 'invalid_operation', 'Expected a 40-character session commit.');
      if (value.directory !== undefined && !validCloneDirectory(value.directory)) fail(400, 'invalid_operation', 'Invalid clone directory.');
      if (value.tag !== undefined && !validPushTag(value.tag)) fail(400, 'invalid_operation', 'Invalid tag name.');
      if (value.tag !== undefined && value.pullRequest !== undefined) fail(400, 'invalid_operation', 'A tag push opens no pull request.');
      return { kind: value.kind, repository: value.repository, ...(value.directory === undefined ? {} : { directory: value.directory as string }),
        branch: value.branch, ...(value.tag === undefined ? {} : { tag: value.tag as string }), commit: value.commit,
        ...(value.pullRequest === undefined ? {} : { pullRequest: pullRequest(value.pullRequest) }) };
    }
    case 'permission': {
      const needs = value.needs;
      if (typeof value.tool !== 'string' || !knownTools.has(value.tool)) fail(400, 'invalid_operation', 'Unknown tool.');
      if (!Array.isArray(needs) || !needs.length || needs.join() !== permissionNeeds.filter(need => needs.includes(need)).join()) {
        fail(400, 'invalid_operation', 'Invalid permission needs.');
      }
      return { kind: value.kind, tool: value.tool, target: text(value.target, 'target', 8192, 0), needs: [...needs] as PermissionNeed[] };
    }
    default: fail(400, 'invalid_operation', 'Unsupported operation.');
  }
}
