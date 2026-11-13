import { browserUnavailableText, type BrowserUnavailableReason } from "../../../../packages/shared/src/browser.js";
import { programsMissingText } from "../../../../packages/shared/src/program-install.js";
import { documentKindNames, type DocumentKind, type GrantSource } from "../../../../packages/shared/src/sources.js";
import type { ToolDefinition } from "../../../../packages/shared/src/tool-definitions.js";
import { tunnelUnavailableText, type TunnelUnavailableReason } from "../../../../packages/shared/src/tunnel.js";
import { programToolsInstructions } from "../defined-tools.js";
import { githubInstructions } from "../github-wait.js";
import { hostGitLfs } from "../sandbox.js";

export type InstructionsMode = "write" | "ask" | "read";

export interface InstructionsInput {
  base: string;
  agentTools: readonly string[];
  mode: InstructionsMode;
  off: ReadonlySet<string>;
  browserUnavailable: BrowserUnavailableReason | undefined;
  tunnelUnavailable: TunnelUnavailableReason | undefined;
  kindsOff: ReadonlySet<DocumentKind>;
  extensionTools: ReadonlySet<string>;
  clone: boolean;
  sandboxed: boolean;
  branch: string;
  cloneRepositories: readonly string[];
  lfsRepositories: readonly string[];
  cloneFailures: readonly { path: string; reason: string }[];
  definitions: readonly ToolDefinition[];
  sources: readonly GrantSource[];
  conversationOnlyRestore: boolean;
  tools: readonly string[];
  missing: readonly { tool: string; programs: readonly string[] }[];
  linuxSandbox: boolean;
  nodeBin: boolean;
  codemode: boolean;
  browser: boolean;
}

export function lfsInstructions(lfsRepositories: readonly string[]): string {
  if (!lfsRepositories.length) return "";
  const lfs = hostGitLfs();
  if (!lfs) return `\nGit LFS is on for ${lfsRepositories.join(", ")}, but git-lfs is not installed on this host, so clones check out LFS pointer files.`;
  return `\nGit LFS is on for ${lfsRepositories.join(", ")}: clones of them check out LFS files' content. In a clone made otherwise, or restored from a backup, `
    + `run ${lfs} install --local, then ${lfs} pull. Other repositories check out LFS pointer files. `
    + "LFS objects are never uploaded from this session, so don't add or change LFS-tracked files in commits you push.";
}

export function agentInstructions(input: InstructionsInput): string {
  const { mode, off, browserUnavailable, tunnelUnavailable, kindsOff, extensionTools } = input;
  let instructions = input.base;
  if (input.clone && !input.sandboxed) {
    instructions += "\n\nTrusted runtime repository context:\n"
      + "The execution root is the session worktree, which starts empty; file-tool paths are relative to it. This host runs without a sandbox: "
      + "clone the repositories you need into the worktree with plain Git (for example git clone https://github.com/<owner>/<name>), "
      + "and fetch, switch, commit and push as usual. Git uses this host's own network and credentials."
      + (input.cloneRepositories.length ? `\nThis workspace's repositories: ${input.cloneRepositories.join(", ")}.` : "");
  } else if (input.clone) {
    const branch = input.branch;
    instructions += "\n\nTrusted runtime repository context:\n"
      + "The execution root is the isolated session worktree, which starts empty; file-tool paths are relative to it. "
      + "Clone the repositories you need into it with plain Git (for example git clone https://github.com/<owner>/<name>), "
      + "and fetch, switch and create branches as usual. Git reaches this workspace's repositories through the session's egress proxy "
      + "with the session owner's own access; no credentials are needed or available. "
      + "Public repositories outside the workspace on GitHub, GitLab, Bitbucket and Codeberg can be cloned the same way, to read their code, "
      + "where the workspace's network access allows their host. Commit with Git. "
      + `This session's own branch is ${branch} (also in $PIKIBUN_SESSION_BRANCH): push your work to it with plain git, for example `
      + `git push origin HEAD:${branch}, in any of the workspace's repositories. Pushes of other branches are refused there.`
      + (input.cloneRepositories.length ? `\nThis workspace's repositories: ${input.cloneRepositories.join(", ")}.` : "")
      + lfsInstructions(input.lfsRepositories)
      + (input.cloneFailures.length ? "\nThis session was restored from a backup or moved, and these clones could not be cloned again: "
        + input.cloneFailures.map(failure => `${failure.path} (${failure.reason})`).join(", ")
        + ". Their backed-up work (branches, and the working tree as a commit) is in Git bundles under .git/pikibun-clones, listed in its "
        + "manifest.json; Pikibun tries again when the session next opens, as long as nothing else is at their paths." : "");
    if (input.agentTools.includes("git_push") && !off.has("git_push"))
      instructions += "\ngit_push publishes a clone's checked-out commit, as it is, to another branch of the workspace repository it was cloned from, "
        + "git_push {directory, branch}, where directory is the clone's path in the worktree. Pushes are fast-forward only (never forced); "
        + "if the branch moved, fetch and merge or rebase first. Optionally request a pull request with pull_request {title, body, base?, draft?}; "
        + `to open one from the session branch once you pushed it, call git_push with branch ${branch}. `
        + "With draft: true it opens as a draft; with draft: false it opens ready for review, or marks the branch's open draft ready for review, "
        + "with that title and body. "
        + "To tag a commit that is already on a branch (a release tag on main, say), check it out in the clone and call "
        + "git_push {directory, branch, tag}: it creates that tag at the commit and moves no branch. Tags are never moved; "
        + "plain git push of tags is refused.";
  }
  const defined = input.definitions.filter(definition => !off.has(definition.name));
  const sources = input.sources.filter(source => !kindsOff.has(source.kind));
  for (const definition of defined) {
    if (definition.kind !== "brokered" || !definition.instructions || !input.agentTools.includes(definition.name)) continue;
    if (definition.instructions.includes("{sources}") && !sources.length) continue;
    instructions += `\n\n${definition.instructions.replaceAll("{sources}",
      sources.map(source => `${JSON.stringify(source.title)} (${documentKindNames[source.kind]} ${source.type}, source ${source.id})`).join(", "))}`;
  }
  if (input.conversationOnlyRestore) instructions += "\n\nThis session was restored from a backup that kept only its conversation: "
    + "the files, clones and uncommitted work its messages from before that restore mention were not restored with it, so they may be "
    + "missing unless they were made again since. Clone the repositories you need again, and check that a file exists before relying on it.";
  if (input.tools.includes("grep")) instructions += "\n\nTo find and read code, use grep (a regular expression or text across the worktree's files, "
    + "with path, glob and context) and read with offset and limit (just the lines around a match) rather than reading whole files: "
    + "their output is already bounded.";
  if (mode !== "ask" && input.tools.includes("move_file")) instructions += "\n\nTo move, copy or delete files and directories, "
    + "use move_file, copy_file and delete_file (write makes the directories it needs).";
  if (mode !== "ask" && input.tools.includes("git") && !off.has("git")) instructions += "\n\nRun Git with the git tool: "
    + "its arguments as a list, with directory naming the clone, such as git {args: [\"clone\", \"https://github.com/<owner>/<name>\"]}, "
    + "git {args: [\"status\"], directory: \"<name>\"} or git {args: [\"commit\", \"-am\", \"Fix the parser\"], directory: \"<name>\"}. "
    + "It needs no quoting.";
  const missing = input.missing;
  if (mode !== "ask") for (const definition of defined) {
    if (definition.kind !== "program" || !definition.instructions) continue;
    const absent = missing.find(item => item.tool === definition.name)?.programs ?? [];
    const managers = input.linuxSandbox ? definition.programs.filter(program => program !== "node" && !absent.includes(program)) : ["npm", "npx"];
    instructions += `\n\n${definition.instructions}`
      + (definition.toolchain === "node" && input.nodeBin ? ` It runs Node.js ${process.versions.node} (this host's connector's own)${managers.length
        ? `, with ${managers.length > 1 ? `${managers.slice(0, -1).join(", ")} and ${managers.at(-1)}` : managers[0]}` : ""}, ahead of any other on PATH.` : "");
  }
  if (mode !== "ask" && input.tools.includes("python") && !off.has("python")) instructions += "\n\nRun Python, pip, uv, poetry and pytest with the python tool "
    + "(there is no shell). Make a virtual environment, then install into it and run there: python {program: \"python3\", args: [\"-m\", \"venv\", \".venv\"], directory: \"<name>\"}, "
    + "python {program: \"pip\", args: [\"install\", \"-r\", \"requirements.txt\"], directory: \"<name>\", venv: \".venv\"}, python {program: \"pytest\", args: [\"-q\"], directory: \"<name>\", venv: \".venv\"}.";
  const programs = mode !== "ask" ? programToolsInstructions(defined) : undefined;
  if (programs) instructions += `\n\n${programs}`;
  const missingText = programsMissingText(Object.fromEntries(missing.map(item => [item.tool, item.programs])));
  if (missingText) instructions += `\n\n${missingText} Calls to them are refused before they run. When a task needs one, use what this session has `
    + "where you can (npx -y pnpm@<version> for a project's pnpm, say, or pytest installed into a virtual environment), and tell the user what the host's owner installs.";
  if (mode !== "ask" && input.codemode) instructions += "\n\nTo chain tools, loop over their results or cut and filter long output, "
    + "write a codemode script that calls them: there is no shell to pipe commands through.";
  const github = mode !== "ask" ? githubInstructions({
    github: input.tools.includes("github_read") && !off.has("github_read"),
    gh: extensionTools.has("gh"),
  }) : "";
  if (github) instructions += `\n\n${github}`;
  if (mode !== "ask" && input.browser && input.tools.includes("browser") && !off.has("browser")) instructions += "\n\nTo look at or test a web page, "
    + "use the browser tool, a headless Chromium in the sandbox that answers with a screenshot, the page's text and its interactive elements: "
    + "browser {url: \"https://example.com/\"}, or for the web app you work on, serve it in the same call, as each call is its own sandboxed command: "
    + "browser {serve: {program: \"pnpm\", args: [\"dev\", \"--port\", \"5173\"], directory: \"<name>\", port: 5173}, url: \"http://localhost:5173/\", "
    + "actions: [{action: \"click\", selector: \"text=Sign in\"}, {action: \"type\", selector: \"#email\", text: \"a@example.com\", submit: true}]}. "
    + "Use the selectors its answer lists.";
  else if (mode !== "ask" && browserUnavailable) instructions += `\n\nThis session has no browser tool: ${browserUnavailableText(browserUnavailable)} `
    + "If you're asked to look at or test a web page, say so, and use what you have instead (fetching it, or running its tests).";
  if (mode === "write" && input.tools.includes("tunnel") && !off.has("tunnel")) instructions += "\n\nTo put the web app you work on online "
    + "at a public https:// address, so people can open it in a browser or on a phone, use the tunnel tool: "
    + "tunnel {action: \"start\", serve: {program: \"pnpm\", args: [\"preview\", \"--port\", \"4173\"], directory: \"<name>\", port: 4173}} runs the server "
    + "in the sandbox as a service that keeps running after the call, and answers with its address once Cloudflare gave it one. "
    + "Have the server listen on that port on localhost and accept any Host header (Vite: --host and server.allowedHosts). "
    + "It starts only for the host's owner or a member they granted host commands, and replaces the one online. tunnel {action: \"status\"} gives the address, "
    + "whether it is connected and the server's last output; tunnel {action: \"stop\"} takes it offline. Stop it once it isn't needed.";
  else if (mode === "write" && tunnelUnavailable) instructions += `\n\nThis session has no tunnel tool: ${tunnelUnavailableText(tunnelUnavailable)} `
    + "If you're asked to put a web app online, say so.";
  if (mode === "ask") instructions += "\n\nThis is a read-only ask. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
  if (mode === "read") instructions += "\n\nThis request is read-only. Inspect isolated session files; a tool call that changes files, runs a command or has any other effect is refused at once, and nothing waits for anyone to allow it. If the task needs a change, say what you would change, and that a message that may act can make it.";
  return instructions;
}
