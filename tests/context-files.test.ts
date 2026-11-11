import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allowedRanges, blockedAddress, collectContext, contextFilesExtension, contextPrompt, DEFAULT_MAX_CHARS, fetchText, hostContextDirectory, maxChars,
  parseContextFiles, repositoryRoots, UrlCache,
} from "../extensions/context-files/context-files.ts";

async function directory(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-context-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function worktree(t: test.TestContext): Promise<string> {
  const root = await directory(t);
  const cwd = join(root, "worktree");
  await mkdir(join(cwd, "app", ".git"), { recursive: true });
  await mkdir(join(cwd, "lib", ".git"), { recursive: true });
  await mkdir(join(cwd, "notes"), { recursive: true });
  await file(join(cwd, "app", "AGENTS.md"), "App agents.");
  await file(join(cwd, "app", "CLAUDE.md"), "App claude.");
  await file(join(cwd, "lib", "CLAUDE.md"), "Lib claude.");
  await file(join(cwd, "notes", "AGENTS.md"), "Not a clone.");
  await file(join(cwd, "app", "docs", "b.md"), "Doc B.");
  await file(join(cwd, "app", "docs", "a.md"), "Doc A.");
  await file(join(cwd, "app", "docs", "c.txt"), "Not markdown.");
  return cwd;
}

test("the setting lists repository paths with alternatives, host files and https URLs, and refuses the rest", () => {
  const entries = parseContextFiles("AGENTS.md|CLAUDE.md, docs/*.md\n# a comment\n\nhost:team.md, https://example.com/rules.md,"
    + "http://example.com/x, /etc/passwd, ~/.ssh/id_rsa, ../other/AGENTS.md, .git/config, *s/x.md, host:../x, https://u:p@example.com/x, a||b");
  assert.deepEqual(entries.map(entry => entry.kind), ["repo", "repo", "host", "url", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "repo"]);
  assert.deepEqual(entries[0], { kind: "repo", text: "AGENTS.md|CLAUDE.md", alternatives: ["AGENTS.md", "CLAUDE.md"] });
  assert.deepEqual(entries[2], { kind: "host", text: "host:team.md", path: "team.md" });
  assert.deepEqual(entries.at(-1), { kind: "repo", text: "a||b", alternatives: ["a", "b"] });
  const reasons = entries.flatMap(entry => entry.kind === "invalid" ? [entry.reason] : []);
  assert.match(reasons[0]!, /only https:\/\//);
  assert.match(reasons[1]!, /relative to the repository.*host:<name>/);
  assert.match(reasons[3]!, /may not leave/);
  assert.match(reasons[4]!, /\.git/);
  assert.match(reasons[5]!, /wildcards/);
  assert.doesNotMatch(reasons[6]!, /host:<name>/, "a host path's reason doesn't point to host: again");
  assert.match(reasons[7]!, /credentials/);
  assert.deepEqual(parseContextFiles(""), []);
  const many = parseContextFiles(Array.from({ length: 60 }, (_, i) => `f${i}.md`).join(","));
  assert.equal(many.length, 51);
  assert.equal(many.at(-1)!.kind, "invalid");
});

test("the character limit has bounds and a default", () => {
  assert.equal(maxChars(undefined), DEFAULT_MAX_CHARS);
  assert.equal(maxChars("abc"), DEFAULT_MAX_CHARS);
  assert.equal(maxChars(" 5000 "), 5000);
  assert.equal(maxChars("10"), 1000);
  assert.equal(maxChars("99999999"), 1_000_000);
});

test("the host's context directory follows Pi's agent directory, or its own variable", () => {
  assert.equal(hostContextDirectory({ PI_CONTEXT_FILES_DIR: "/srv/context" }), "/srv/context");
  assert.equal(hostContextDirectory({ PI_CODING_AGENT_DIR: "/opt/pi" }), join("/opt/pi", "context-files"));
  assert.match(hostContextDirectory({}), /\.pi[/\\]agent[/\\]context-files$/);
});

test("repository paths are looked up in a repository, or in each clone of a worktree", async t => {
  const cwd = await worktree(t);
  assert.deepEqual(await repositoryRoots(cwd), [cwd, join(cwd, "app"), join(cwd, "lib")], "a directory without .git isn't a clone");
  assert.deepEqual(await repositoryRoots(join(cwd, "app")), [join(cwd, "app")], "Pi run in a project reads that project only");
});

test("each clone gets the first alternative it has, wildcards match in name order, and missing files are no problem", async t => {
  const cwd = await worktree(t);
  const collected = await collectContext(cwd, await repositoryRoots(cwd), parseContextFiles("AGENTS.md|CLAUDE.md, docs/*.md, CONTRIBUTING.md"));
  assert.deepEqual(collected.files, [
    { label: "app/AGENTS.md", text: "App agents." },
    { label: "lib/CLAUDE.md", text: "Lib claude." },
    { label: "app/docs/a.md", text: "Doc A." },
    { label: "app/docs/b.md", text: "Doc B." },
  ]);
  assert.deepEqual(collected.problems, []);
  const again = await collectContext(cwd, await repositoryRoots(cwd), parseContextFiles("app/AGENTS.md, AGENTS.md"));
  assert.deepEqual(again.files.map(item => item.label), ["app/AGENTS.md"], "a file named twice is added once");
});

test("a repository file that links outside its repository or into .git is never read", async t => {
  const cwd = await worktree(t);
  const secret = join(cwd, "..", "secret.txt");
  await writeFile(secret, "TOP SECRET");
  await file(join(cwd, "app", ".git", "config"), "url = https://user:TOKEN@github.com/acme/app");
  await file(join(cwd, "app", "guides", "style.md"), "Style.");
  await symlink(secret, join(cwd, "app", "LINKED.md"));
  await symlink(join(cwd, "lib", "CLAUDE.md"), join(cwd, "app", "SIBLING.md"));
  await symlink(join(cwd, "app", ".git", "config"), join(cwd, "app", "GIT.md"));
  await symlink(join(cwd, "app", "guides", "style.md"), join(cwd, "app", "STYLE.md"));
  const collected = await collectContext(cwd, await repositoryRoots(cwd), parseContextFiles("LINKED.md, SIBLING.md, GIT.md, STYLE.md"));
  assert.doesNotMatch(JSON.stringify(collected.files), /TOP SECRET|TOKEN|Lib claude/);
  const refused = "it links outside its directory or into .git, so it was not read";
  assert.deepEqual(collected.problems, [`app/LINKED.md: ${refused}`, `app/SIBLING.md: ${refused}`, `app/GIT.md: ${refused}`]);
  assert.deepEqual(collected.files, [{ label: "app/guides/style.md", text: "Style." }], "a link within its repository is read, as its target");
});

test("a wildcard's matches are files: directories that match take none of their places", async t => {
  const cwd = await worktree(t);
  for (let i = 0; i < 25; i++) await mkdir(join(cwd, "app", "docs", `${String(i).padStart(2, "0")}.md`));
  const collected = await collectContext(cwd, [join(cwd, "app")], parseContextFiles("docs/*.md"));
  assert.deepEqual(collected.files.map(item => item.label), ["app/docs/a.md", "app/docs/b.md"]);
});

test("host files come only from the host's context directory", async t => {
  const cwd = await worktree(t);
  const host = join(cwd, "..", "host-context");
  await file(join(host, "team.md"), "Team rules.");
  await file(join(host, "style", "ts.md"), "TS style.");
  await writeFile(join(cwd, "..", "outside.md"), "OUTSIDE");
  await symlink(join(cwd, "..", "outside.md"), join(host, "escape.md"));
  const collected = await collectContext(cwd, await repositoryRoots(cwd), parseContextFiles("host:team.md, host:style/*.md, host:missing.md, host:escape.md"),
    { hostDirectory: host });
  assert.deepEqual(collected.files, [{ label: "host:team.md", text: "Team rules." }, { label: "host:style/ts.md", text: "TS style." }]);
  assert.deepEqual(collected.problems, ["host:missing.md: not found on the host", "host:escape.md: it links outside its directory or into .git, so it was not read"]);
  const none = await collectContext(cwd, [cwd], parseContextFiles("host:team.md"), { hostDirectory: join(cwd, "nowhere") });
  assert.deepEqual(none.problems, ["host:team.md: not found on the host"]);
  const reposOnly = await collectContext(cwd, [cwd], parseContextFiles("host:team.md, https://example.com/x, /etc/passwd"), { hostDirectory: host, only: "repo" });
  assert.deepEqual(reposOnly, { files: [], problems: [] }, "a new clone's note reads its repository files only");
});

test("pages are fetched once in a while; a page that fails again keeps its last text", async t => {
  const cwd = await worktree(t);
  let calls = 0;
  let fail = false;
  const urls = new UrlCache(async url => { calls++; if (fail) throw new Error("HTTP 503"); return `Page ${url}`; }, 1000);
  const entries = parseContextFiles("https://example.com/rules.md");
  const first = await collectContext(cwd, [cwd], entries, { urls });
  assert.deepEqual(first.files, [{ label: "https://example.com/rules.md", text: "Page https://example.com/rules.md" }]);
  await collectContext(cwd, [cwd], entries, { urls });
  assert.equal(calls, 1, "within its time, the page isn't fetched again");
  fail = true;
  assert.deepEqual(await urls.get("https://example.com/rules.md", undefined, Date.now() + 5000), { text: "Page https://example.com/rules.md" });
  assert.equal(calls, 2);
  assert.deepEqual(await urls.get("https://example.com/other.md", undefined, Date.now() + 5000), { error: "HTTP 503" });
  const failed = await collectContext(cwd, [cwd], parseContextFiles("https://example.com/other.md"), { urls });
  assert.deepEqual(failed.problems, ["https://example.com/other.md: HTTP 503"]);
});

test("a failed page is tried again within a minute, and a stopped message's page at once", async () => {
  let calls = 0;
  let outcome: "ok" | "fail" = "fail";
  const urls = new UrlCache(async (_url, signal) => {
    calls++;
    if (signal?.aborted) throw new Error("This operation was aborted");
    if (outcome === "fail") throw new Error("HTTP 503");
    return "Page";
  });
  const start = Date.now();
  assert.deepEqual(await urls.get("https://example.com/a.md", undefined, start), { error: "HTTP 503" });
  assert.deepEqual(await urls.get("https://example.com/a.md", undefined, start + 30_000), { error: "HTTP 503" });
  assert.equal(calls, 1, "within a minute, a failure stands");
  outcome = "ok";
  assert.deepEqual(await urls.get("https://example.com/a.md", undefined, start + 61_000), { text: "Page" });
  assert.equal(calls, 2);
  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await urls.get("https://example.com/b.md", stopped.signal, start), { error: "This operation was aborted" });
  assert.deepEqual(await urls.get("https://example.com/b.md", undefined, start + 1), { text: "Page" }, "a stopped load isn't remembered as a failure");
});

test("pages load side by side, and are added in the setting's order", async t => {
  const cwd = await worktree(t);
  let running = 0;
  let most = 0;
  const urls = new UrlCache(async url => {
    running++;
    most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, url.endsWith("slow.md") ? 30 : 5));
    running--;
    return `Page ${url.slice(-7)}`;
  });
  const collected = await collectContext(cwd, [cwd], parseContextFiles("https://example.com/slow.md, https://example.com/fast.md, https://example.com/slow.md"), { urls });
  assert.equal(most, 2, "both pages loaded at once, the repeated one once");
  assert.deepEqual(collected.files.map(item => item.text), ["Page slow.md", "Page fast.md"]);
});

test("URLs never reach the host's own or private networks, unless its owner allows a range", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.66",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001::1", "2002:a00:1::1", "not an address"]) {
    assert.equal(blockedAddress(address, allowedRanges("")), true, address);
  }
  for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(blockedAddress(address, allowedRanges("")), false, address);
  assert.equal(blockedAddress("198.18.0.66", allowedRanges("198.18.0.0/15, nonsense, 10.0.0.0/99")), false, "a fake-IP proxy's range, allowed");
  assert.equal(blockedAddress("10.0.0.1", allowedRanges("198.18.0.0/15, nonsense, 10.0.0.0/99")), true);
  await assert.rejects(fetchText("https://127.0.0.1/rules.md"), /private network/);
  await assert.rejects(fetchText("https://[::1]/rules.md"), /private network/);
  const resolver = ((hostname: string, _options: unknown, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) =>
    callback(null, hostname === "internal.example.com" ? [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] : [])) as never;
  await assert.rejects(fetchText("https://internal.example.com/rules.md", undefined, resolver), /internal\.example\.com is on a private network \(10\.0\.0\.5\)/);
  await assert.rejects(fetchText("https://nowhere.example.com/rules.md", undefined, resolver), /private network \(no address\)/);
  await assert.rejects(fetchText("http://example.com/rules.md"), /https/);
});

test("the prompt section keeps files within the limit and says what it left out or couldn't load", () => {
  assert.equal(contextPrompt({ files: [], problems: [] }, 1000), undefined);
  assert.equal(contextPrompt({ files: [{ label: "a", text: "  \n" }], problems: [] }, 1000), undefined, "empty files add nothing");
  const section = contextPrompt({ files: [{ label: "app/AGENTS.md", text: "x".repeat(1500) }, { label: "lib/CLAUDE.md", text: "y" }],
    problems: ["host:x.md: not found on the host"] }, 1000)!;
  assert.match(section, /^# Project context\n\nProject-specific instructions/);
  assert.match(section, /## app\/AGENTS\.md\n\nx{1000}\n\n\[… 500 more characters cut, over the limit of 1000: read the file for the rest\]/);
  assert.match(section, /Left out, over the limit of 1000 characters \(read them if the task needs them\): lib\/CLAUDE\.md\./);
  assert.match(section, /Not loaded: host:x\.md: not found on the host\.$/);
});

function load(flags: Record<string, string> = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registered: string[] = [];
  contextFilesExtension({
    registerFlag: (name: string) => { registered.push(name); },
    getFlag: (name: string) => flags[name] ?? (name === "context-files" ? "AGENTS.md|CLAUDE.md" : "60000"),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
  } as never);
  return { handlers, registered };
}

test("each message's system prompt gets the files, after Pi's base; Pi's own context files aren't added twice", async t => {
  const cwd = await worktree(t);
  const { handlers, registered } = load();
  assert.deepEqual(registered, ["context-files", "context-max-chars"]);
  const started = await handlers.get("before_agent_start")!({ systemPrompt: "Base." }, { cwd }) as { systemPrompt: string };
  assert.match(started.systemPrompt, /^Base\.\n\n# Project context\n\n/);
  assert.match(started.systemPrompt, /## app\/AGENTS\.md\n\nApp agents\./);
  assert.match(started.systemPrompt, /## lib\/CLAUDE\.md\n\nLib claude\./);
  assert.doesNotMatch(started.systemPrompt, /App claude|Not a clone/);
  const plain = await handlers.get("before_agent_start")!({ systemPrompt: "Base.",
    systemPromptOptions: { contextFiles: [{ path: join(cwd, "app", "AGENTS.md"), content: "App agents." }] } }, { cwd: join(cwd, "app") });
  assert.equal(plain, undefined, "in plain Pi, a file Pi already loaded is left to Pi");
  const empty = load({ "context-files": "" });
  assert.equal(await empty.handlers.get("before_agent_start")!({ systemPrompt: "Base." }, { cwd }), undefined, "an empty setting adds nothing");
});

test("a clone made during a message gets its files in the result of the call that made it", async t => {
  const cwd = await worktree(t);
  const { handlers } = load();
  const result = (text: string) => ({ toolName: "git", input: {}, content: [{ type: "text", text }], isError: false });
  assert.equal(await handlers.get("tool_result")!(result("before any message"), { cwd }), undefined);
  await handlers.get("before_agent_start")!({ systemPrompt: "Base." }, { cwd });
  assert.equal(await handlers.get("tool_result")!(result("nothing new"), { cwd }), undefined);
  await mkdir(join(cwd, "web", ".git"), { recursive: true });
  await file(join(cwd, "web", "AGENTS.md"), "Web agents.");
  const noted = await handlers.get("tool_result")!(result("Cloning into 'web'..."), { cwd }) as { content: { type: string; text: string }[] };
  assert.equal(noted.content[0]!.text, "Cloning into 'web'...");
  assert.match(noted.content[1]!.text, /^# Project context of web, cloned just now\n\n[^]*## web\/AGENTS\.md\n\nWeb agents\.$/);
  assert.equal(await handlers.get("tool_result")!(result("again"), { cwd }), undefined, "once per clone");
  await mkdir(join(cwd, "bare", ".git"), { recursive: true });
  assert.equal(await handlers.get("tool_result")!(result("Cloning into 'bare'..."), { cwd }), undefined, "a clone without the files adds nothing");
});

test("the package's module is the extension, and the connector's piki:context-files", async () => {
  assert.equal((await import("../extensions/context-files/index.ts")).default, contextFilesExtension);
  const { connectorPikiExtension } = await import("../apps/runner/src/extensions/piki/index.ts");
  assert.equal(connectorPikiExtension("piki:context-files")!.factory, contextFilesExtension);
});
