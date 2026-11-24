import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedMatcher, cliRules } from "../apps/runner/src/extensions/piki/cli-engine.js";
import { ToolDefinitionsSource, TOOL_DEFINITIONS_TTL_MS } from "../apps/runner/src/tool-definitions-source.js";
import { azureCliDefinition, bundledCliDefinitions, cliDefinitionLimits, cliPatternCount, ghDefinition, parseCliDefinition, parseCliDefinitions,
  type CliDefinition } from "../packages/shared/src/cli-definitions.js";
import { bundledToolDefinitions, parseToolDefinitions } from "../packages/shared/src/tool-definitions.js";

const catastrophic = "^(a+)+$";
const stalling = `${"a".repeat(40)}b`;

test("a served pattern that backtracks without end costs a call a bounded time, and the call is refused rather than let through", () => {
  const notes: string[] = [];
  const served: CliDefinition = { ...ghDefinition, refuse: [{ words: ["api"], argPattern: catastrophic, reason: "a served rule" }],
    hints: [{ outputPattern: catastrophic, hint: "never shown" }] };
  const rules = cliRules(served, message => { notes.push(message); });
  const started = performance.now();
  const refused = rules.refused(["api", stalling]);
  const hints = rules.hints(["run", "list"], stalling);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  assert.match(refused ?? "", /^a served rule: an argument couldn't be checked against this rule \(it is longer than 4096 characters, or the check took too long\)$/);
  assert.deepEqual(hints, [], "a hint whose pattern couldn't be checked isn't given");
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /the pattern \^\(a\+\)\+\$ took longer than a rule check may \(100 ms/);
  assert.equal(rules.refused(["api", "aaa"]), "a served rule");
  assert.equal(rules.refused(["api", "repos/acme/app"]), undefined);
  assert.equal(rules.refused(["pr", "list", stalling]), undefined, "a rule whose words don't match never runs its pattern");

  const matcher = new BoundedMatcher(() => {}, 30);
  assert.equal(matcher.some(new RegExp(catastrophic), [stalling]), "unchecked");
  assert.equal(matcher.some(/a/, ["a"]), "unchecked", "once a call's time is spent, its other patterns aren't run");
  assert.equal(new BoundedMatcher().some(/token/i, ["x", "my-TOKEN"]), true);
  assert.equal(new BoundedMatcher().some(/token/i, ["x", "y"]), false);
});

test("a pattern sees arguments of at most 4096 characters and output of at most 128 KB; what it can't see counts against the call", () => {
  const long = `${"x".repeat(cliDefinitionLimits.patternInput)}token`;
  const gh = cliRules(ghDefinition);
  assert.equal(gh.refused(["config", "get", "token"]), "gh config get would show its token");
  assert.match(gh.refused(["config", "get", long]) ?? "", /^gh config get would show its token: an argument couldn't be checked/);
  assert.equal(gh.refused(["config", "get", "editor"]), undefined);
  assert.equal(gh.refused(["issue", "create", "--title", "t", "--body", "token ".repeat(20_000)]), undefined, "a long argument of a call no pattern rule covers is no reason to refuse");
  assert.equal(gh.refused(["config", "get", "x".repeat(cliDefinitionLimits.patternInput)]), undefined, "the limit itself is still checked");

  const az = cliRules(azureCliDefinition);
  assert.equal(az.writes(["repos", "pr", "list"]), undefined);
  assert.match(az.writes(["repos", "pr", `list-${"a".repeat(5000)}`]) ?? "", /may show keys or secrets$/, "an over-long command word isn't taken for a read");
  assert.match(az.writes(["keyvault", "secret", "list"]) ?? "", /may show keys or secrets/);

  const marker = "x509: certificate signed by unknown authority";
  const filler = "y".repeat(cliDefinitionLimits.patternOutput);
  assert.equal(gh.hints(["run", "list"], `${marker}\n${filler}`).length, 1, "the start of long output is read");
  assert.equal(gh.hints(["run", "list"], `${filler}\n${marker}`).length, 1, "and its end");
  assert.equal(gh.hints(["run", "list"], `${filler}\n${marker}\n${filler}`).length, 0, "not its middle");
  assert.deepEqual(cliDefinitionLimits, { definitions: 16, rules: 64, words: 64, word: 128, text: 4096, pattern: 256, patterns: 32, patternInput: 4096,
    patternOutput: 128 * 1024, matchMs: 100 });
});

test("a definition carries at most 32 patterns of at most 256 characters, hints' output patterns included", () => {
  for (const definition of bundledCliDefinitions) assert.ok(cliPatternCount(definition) <= cliDefinitionLimits.patterns, definition.name);
  assert.equal(cliPatternCount(ghDefinition), 5);
  const plain = JSON.parse(JSON.stringify(ghDefinition)) as CliDefinition;
  const refusals = (count: number) => Array.from({ length: count }, (_, index) => ({ words: ["x"], argPattern: `p${index}`, reason: "x" }));
  const hints = (count: number) => Array.from({ length: count }, (_, index) => ({ outputPattern: `p${index}`, hint: "x" }));
  assert.equal(parseCliDefinition({ ...plain, refuse: refusals(16), hints: hints(16) }).refuse.length, 16);
  assert.throws(() => parseCliDefinition({ ...plain, refuse: refusals(33), hints: [] }), /Invalid CLI definition: more than 32 patterns/);
  assert.throws(() => parseCliDefinition({ ...plain, refuse: refusals(16), hints: hints(17) }), /more than 32 patterns/, "output patterns count too");
  assert.throws(() => parseCliDefinition({ ...plain, hints: [{ outputPattern: "a".repeat(257), hint: "x" }] }), /Invalid CLI definition: hint output pattern/);
  assert.throws(() => parseCliDefinition({ ...plain, refuse: [{ argPattern: "a".repeat(257), reason: "x" }] }), /Invalid CLI definition: refusal pattern/);
  assert.throws(() => parseCliDefinition({ ...plain, later: true }), /Invalid CLI definition: CLI has a key this version doesn't know \(later\)/,
    "a key it doesn't know still drops the whole definition, and the reason names the key");
});

test("a definition the parser passes over is logged once, with the reason, so a host's owner can see why a rule or a tool is missing", async () => {
  const reasons: string[] = [];
  const found = parseCliDefinitions([{ kind: "cli", name: "glab" }, ghDefinition, { ...ghDefinition }, 7], (name, reason) => { reasons.push(`${name}: ${reason}`); });
  assert.deepEqual(found.map(item => item.name), ["gh"]);
  assert.equal(reasons.length, 3);
  assert.match(reasons[0]!, /^glab: Invalid CLI definition: /);
  assert.equal(reasons[1], "gh: a second definition of that name");
  assert.match(reasons[2]!, /^: Invalid CLI definition: kind$/);
  const whole: string[] = [];
  assert.deepEqual(parseCliDefinitions({}, (_name, reason) => { whole.push(reason); }), []);
  assert.deepEqual(parseCliDefinitions(undefined, (_name, reason) => { whole.push(reason); }), [], "a Pikibun server from before served rules sends none, which is nothing to log");
  assert.deepEqual(whole, ["the CLI definitions aren't a list"]);
  const tools: string[] = [];
  const node = bundledToolDefinitions.find(item => item.name === "node")!;
  assert.deepEqual(parseToolDefinitions({ tools: [node, { kind: "later", name: "jvm" }, node] }, (name, reason) => { tools.push(`${name}: ${reason}`); }).map(item => item.name), ["node"]);
  assert.equal(tools.length, 2);
  assert.match(tools[0]!, /^jvm: /);
  assert.equal(tools[1], "node: a second definition of that name");

  let now = 0;
  let answer: unknown = { tools: [node, { kind: "later", name: "jvm" }], clis: [ghDefinition, { ...JSON.parse(JSON.stringify(ghDefinition)), name: "glab", extension: "piki:glab", later: true }] };
  const lines: string[] = [];
  const source = new ToolDefinitionsSource(async () => answer, () => now, line => { lines.push(line); });
  assert.deepEqual((await source.clis()).map(item => item.name), ["gh"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^Tool definitions from Pikibun: the tool jvm is passed over, so sessions on this host don't get it: /);
  assert.equal(lines[1], "Tool definitions from Pikibun: the rules for glab are passed over, so only this connector's own apply to it: "
    + "Invalid CLI definition: CLI has a key this version doesn't know (later)");
  now += TOOL_DEFINITIONS_TTL_MS;
  await source.get();
  assert.equal(lines.length, 2, "the same definition passed over again isn't logged again");
  now += TOOL_DEFINITIONS_TTL_MS;
  answer = { tools: "none", clis: [] };
  assert.deepEqual((await source.clis()).map(item => item.name), ["gh"], "an answer that can't be read leaves the rules last read");
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /the answer couldn't be read, so the definitions last read stay: Invalid tool definitions/);
  now += TOOL_DEFINITIONS_TTL_MS;
  answer = { tools: [node], clis: [ghDefinition] };
  await source.get();
  assert.equal(lines.length, 3);
  now += TOOL_DEFINITIONS_TTL_MS;
  answer = { tools: [node, { kind: "later", name: "jvm" }], clis: [ghDefinition] };
  await source.get();
  assert.equal(lines.length, 4, "one that is passed over again after it was taken is logged again");
});
