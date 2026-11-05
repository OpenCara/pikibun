import assert from "node:assert/strict";
import test from "node:test";
import { settleToolNames } from "../apps/runner/src/extensions/adapter.js";
import { builtinExtensions } from "../packages/shared/src/host-config.js";
import type { InstalledExtension, WorkspaceExtension } from "../packages/shared/src/host-extensions.js";
import { pikiSessionToolExtensions } from "../packages/shared/src/piki-extensions.js";
import { descriptionSummary, extensionLabel, extensionOffer, pikibunToolDescriptions, workspaceTools } from "../packages/shared/src/workspace-tools.js";

const own = pikiSessionToolExtensions().filter(item => !item.retired);
/** The session's own tools, as the workspace page lists them: the file tools, which every session has, first. */
const sessionTools = [...own.filter(item => item.core), ...own.filter(item => !item.core)].flatMap(item => item.sessionTools ?? []);
const enabled = (source: string, tools: WorkspaceExtension["tools"] = "approval"): WorkspaceExtension => ({ source, enabled: true, tools, settings: {} });
const disabled = (source: string): WorkspaceExtension => ({ source, enabled: false, tools: "approval", settings: {} });
const installed = (source: string, tools: string[], extra: Partial<InstalledExtension> = {}): InstalledExtension => ({
  source, dev: false, modules: [{ path: "index.js", tools: tools.map(name => ({ name, description: `${name} does things.` })), events: [], flags: [], noops: [], ignored: [] }], ...extra,
});

test("Pikibun describes each of its own tools, the session's and code mode's, for the workspace page", () => {
  const own = [...sessionTools, ...builtinExtensions.flatMap(item => item.tools)];
  assert.deepEqual(Object.keys(pikibunToolDescriptions).sort(), [...new Set(own)].sort());
  for (const name of own) assert.ok(pikibunToolDescriptions[name]!.length > 10, name);
});

test("a workspace that chose nothing gives its sessions every tool of Pikibun's own and code mode", () => {
  const usable = workspaceTools([], []);
  assert.deepEqual(usable.tools.map(tool => tool.name), [...sessionTools, "codemode"]);
  assert.deepEqual(usable.tools.slice(0, 3).map(tool => tool.name), ["identity", "list_files", "read_file"]);
  assert.ok(usable.tools.every(tool => tool.origin === (tool.name === "codemode" ? "builtin" : "session") && tool.description));
  assert.equal(usable.tools.find(tool => tool.name === "git_push")?.source, "piki:git");
  assert.equal(usable.tools.find(tool => tool.name === "codemode")?.source, "pi:codemode");
  assert.deepEqual(usable.off, []);
  assert.deepEqual(usable.shadowed, []);
  assert.deepEqual(usable.unreported, []);
  // Retired switches (bash, host_bash) list nothing, whatever the workspace chose.
  assert.ok(!usable.tools.some(tool => tool.name === "bash" || tool.name === "host_bash"));
});

test("session tools a workspace turns off leave the list, except the core ones it can't turn off", () => {
  const usable = workspaceTools([disabled("piki:git"), disabled("piki:files"), disabled("piki:shell")], []);
  assert.deepEqual(usable.off, [{ name: "git", source: "piki:git" }, { name: "git_push", source: "piki:git" }]);
  assert.ok(!usable.tools.some(tool => tool.name === "git" || tool.name === "git_push"));
  assert.ok(usable.tools.some(tool => tool.name === "read_file"));
});

test("enabled extensions add the tools hosts report, with how they run; disabled, unreported and broken ones add none", () => {
  const usable = workspaceTools([
    enabled("npm:pi-web-access@0.46.0", "automatic"), disabled("npm:pi-web-search@1.7.0"), enabled("npm:cc-safety-net@2.7.2"),
    enabled("npm:never-reported@1.0.0"), enabled("npm:other-version@2.0.0"), enabled("npm:broken@1.0.0"),
  ], [
    installed("npm:pi-web-access@0.46.0", ["web_search", "fetch_content"], { description: "Web search and page reading." }),
    installed("npm:pi-web-search@1.7.0", ["web_search"]),
    installed("npm:cc-safety-net@2.7.2", []),
    installed("npm:other-version@1.0.0", ["older"]),
    installed("npm:broken@1.0.0", ["broken"], { error: "Cannot find module" }),
  ]);
  const extension = usable.tools.filter(tool => tool.origin === "extension");
  assert.deepEqual(extension.map(tool => [tool.name, tool.source, tool.mode]),
    [["web_search", "npm:pi-web-access@0.46.0", "automatic"], ["fetch_content", "npm:pi-web-access@0.46.0", "automatic"]]);
  assert.equal(extension[0]!.description, "web_search does things.");
  assert.deepEqual(usable.unreported, ["npm:never-reported@1.0.0", "npm:other-version@2.0.0", "npm:broken@1.0.0"]);
  assert.deepEqual(usable.shadowed, []);
  assert.equal(extensionOffer("npm:pi-web-access@0.46.0", [installed("npm:pi-web-access@0.46.0", ["web_search"], { description: "Web search." })])?.description, "Web search.");
});

test("names are settled as sessions settle them: Pikibun's own first, even turned off, then the workspace's order; an extension replaces code mode", () => {
  const extensions = [
    disabled("piki:node"),
    enabled("npm:first@1.0.0"), enabled("npm:second@1.0.0"), enabled("npm:third@1.0.0"), enabled("npm:modes@1.0.0"),
  ];
  const reports = [
    installed("npm:first@1.0.0", ["web_search", "read_file", "node"]),
    installed("npm:second@1.0.0", ["web_search", "fetch"]),
    installed("npm:third@1.0.0", ["web_search"]),
    installed("npm:modes@1.0.0", ["codemode"]),
  ];
  const usable = workspaceTools(extensions, reports);
  assert.deepEqual(usable.shadowed, [
    { name: "read_file", source: "npm:first@1.0.0", by: "piki:files" },
    { name: "node", source: "npm:first@1.0.0", by: "piki:node" },
    { name: "web_search", source: "npm:second@1.0.0", by: "npm:first@1.0.0" },
    { name: "web_search", source: "npm:third@1.0.0", by: "npm:first@1.0.0" },
    { name: "codemode", source: "pi:codemode", by: "npm:modes@1.0.0" },
  ]);
  assert.deepEqual(usable.tools.filter(tool => tool.origin !== "session").map(tool => `${tool.source} ${tool.name}`),
    ["npm:first@1.0.0 web_search", "npm:second@1.0.0 fetch", "npm:modes@1.0.0 codemode"]);
  assert.ok(!usable.tools.some(tool => tool.name === "node"));
  // The runner's own rule, which sessions apply, keeps the same tools.
  const settled = settleToolNames(reports.map(report => ({ source: report.source, tools: report.modules.flatMap(module => module.tools.map(tool => tool.name)) })), sessionTools);
  assert.deepEqual(settled.flatMap(item => item.kept.map(name => `${item.source} ${name}`)),
    usable.tools.filter(tool => tool.origin === "extension").map(tool => `${tool.source} ${tool.name}`));
});

test("Pikibun's own extensions describe themselves without a host's report, and its command-line ones name their tool", () => {
  const gh = extensionOffer("piki:gh", []);
  assert.deepEqual(gh?.tools.map(tool => tool.name), ["gh"]);
  assert.match(gh!.description!, /GitHub CLI/);
  assert.deepEqual(extensionOffer("piki:prompt-audit", [])?.tools, []);
  assert.deepEqual(extensionOffer("piki:github", [])?.tools.map(tool => tool.name), ["github_read", "github_comment", "github_issue", "github_merge"]);
  // A host's report gives the tool's own description, the catalogue the extension's.
  const reported = extensionOffer("piki:gh", [installed("piki:gh", ["gh"], { description: "Reported." })]);
  assert.equal(reported?.tools[0]?.description, "gh does things.");
  assert.match(reported!.description!, /GitHub CLI/);
  const usable = workspaceTools([enabled("piki:gh"), enabled("piki:prompt-audit")], []);
  assert.deepEqual(usable.tools.filter(tool => tool.origin === "extension").map(tool => tool.name), ["gh"]);
  assert.deepEqual(usable.unreported, []);
});

test("extensions get short labels, and long descriptions a summary", () => {
  assert.equal(extensionLabel("piki:git"), "Git");
  assert.equal(extensionLabel("pi:codemode"), "Code mode");
  assert.equal(extensionLabel("npm:@scope/pkg@1.2.3"), "@scope/pkg");
  assert.equal(extensionLabel(`git:https://github.com/acme/guard@${"a".repeat(40)}`), "guard");
  assert.equal(extensionLabel("local:/home/me/ext"), "local:/home/me/ext");
  assert.equal(descriptionSummary("Short.\n\nMore detail."), "Short.");
  assert.equal(descriptionSummary("  Spaced\n  out  "), "Spaced out");
  const long = `${"word ".repeat(30)}ends here. ${"more ".repeat(40)}`;
  assert.equal(descriptionSummary(long, 200), `${"word ".repeat(30)}ends here.`);
  const unbroken = "x".repeat(150) + " " + "y".repeat(100);
  assert.equal(descriptionSummary(unbroken, 200), `${"x".repeat(150)}…`);
  assert.equal(descriptionSummary(""), "");
});
