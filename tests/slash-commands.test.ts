import test from "node:test";
import assert from "node:assert/strict";
import { parseSlashDraft, slashCommand, slashCommands, slashLevel, slashModel, slashSuggestions, type SlashOffer } from "../packages/client/src/slash-commands.js";

const sonnet = { provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet" };
const opus = { provider: "anthropic", modelId: "claude-opus", name: "Claude Opus" };
const relayed = { provider: "relay", modelId: "claude-sonnet", name: "Sonnet through the relay" };
const gpt = { provider: "openai", modelId: "gpt-6", name: "GPT-6" };

const offer: SlashOffer = { commands: slashCommands.map(command => command.name), models: [sonnet, opus, gpt], levels: ["off", "low", "high", "xhigh"] };
const drafts = (draft: string, from: SlashOffer = offer) => slashSuggestions(draft, from).map(item => item.draft);

test("a draft is a command only when it starts with a slash and stays on one line", () => {
  assert.deepEqual(parseSlashDraft("/"), { name: "", argument: "", naming: true });
  assert.deepEqual(parseSlashDraft("/mo"), { name: "mo", argument: "", naming: true });
  assert.deepEqual(parseSlashDraft("/Model "), { name: "model", argument: "", naming: false });
  assert.deepEqual(parseSlashDraft("/name  Fix the login test  "), { name: "name", argument: "Fix the login test", naming: false });
  assert.deepEqual(parseSlashDraft("/copy\n"), { name: "copy", argument: "", naming: false });
  for (const draft of ["", "hello", " /copy", "say /copy", "/name one\ntwo", "/copy\n\nand then"]) assert.equal(parseSlashDraft(draft), undefined, JSON.stringify(draft));
});

test("only Pikibun's own commands run: any other text that starts with a slash is a message", () => {
  assert.deepEqual(slashCommand("/copy"), { command: slashCommands.find(command => command.name === "copy"), argument: "" });
  assert.equal(slashCommand("/THINKING high")?.command.name, "thinking");
  assert.equal(slashCommand("/thinking high")?.argument, "high");
  for (const draft of ["/usr/local/bin is missing from PATH", "/skill:review this", "/compact", "/", "/copying", " /copy"]) assert.equal(slashCommand(draft), undefined, draft);
});

test("typing a slash lists the commands offered, narrowed by what follows it", () => {
  assert.deepEqual(drafts("/"), ["/model ", "/thinking ", "/name ", "/new", "/clone", "/copy", "/session", "/settings"]);
  assert.deepEqual(drafts("/s"), ["/session", "/settings"]);
  assert.deepEqual(drafts("/C"), ["/clone", "/copy"]);
  assert.deepEqual(drafts("/usr"), []);
  assert.deepEqual(drafts("hello /"), []);
  assert.deepEqual(drafts("/", { ...offer, commands: ["copy", "new"] }), ["/new", "/copy"]);
  const [model, , name, fresh] = slashSuggestions("/", offer);
  assert.deepEqual(model, { key: "model", label: "/model [provider/model]", hint: "Choose the model for your next messages", draft: "/model ", runs: false });
  assert.deepEqual(name, { key: "name", label: "/name [title]", hint: "Rename this session", draft: "/name ", runs: true });
  assert.deepEqual(fresh, { key: "new", label: "/new", hint: "Start a new session in this workspace", draft: "/new", runs: true });
});

test("a command that takes one of a few values lists them once its name is typed", () => {
  assert.deepEqual(drafts("/model "), ["/model anthropic/claude-sonnet", "/model anthropic/claude-opus", "/model openai/gpt-6"]);
  assert.deepEqual(drafts("/model OPUS"), ["/model anthropic/claude-opus"]);
  assert.deepEqual(drafts("/model openai/"), ["/model openai/gpt-6"]);
  assert.deepEqual(drafts("/model llama"), []);
  assert.deepEqual(slashSuggestions("/model gpt", offer), [{ key: "openai/gpt-6", label: "GPT-6", hint: "openai/gpt-6", draft: "/model openai/gpt-6", runs: true }]);
  assert.deepEqual(drafts("/thinking "), ["/thinking off", "/thinking low", "/thinking high", "/thinking xhigh"]);
  assert.deepEqual(drafts("/thinking extra"), ["/thinking xhigh"]);
  assert.deepEqual(drafts("/thinking x"), ["/thinking xhigh"]);
  assert.deepEqual(drafts("/name "), []);
  assert.deepEqual(drafts("/model ", { ...offer, commands: ["copy"] }), []);
  assert.deepEqual(drafts("/nope "), []);
});

test("a model named exactly comes first in /model's list, so Return picks the model that was typed", () => {
  const mini = { provider: "openai", modelId: "gpt-6-mini", name: "GPT-6 mini" };
  const listed: SlashOffer = { ...offer, models: [mini, gpt, sonnet] };
  assert.deepEqual(drafts("/model gpt", listed), ["/model openai/gpt-6-mini", "/model openai/gpt-6"]);
  assert.deepEqual(drafts("/model openai/gpt-6", listed), ["/model openai/gpt-6", "/model openai/gpt-6-mini"]);
  assert.deepEqual(drafts("/model OpenAI/GPT-6", listed), ["/model openai/gpt-6", "/model openai/gpt-6-mini"]);
  assert.deepEqual(drafts("/model gpt-6", listed), ["/model openai/gpt-6", "/model openai/gpt-6-mini"]);
  assert.deepEqual(drafts("/model GPT-6 mini", listed), ["/model openai/gpt-6-mini"]);
  for (const typed of ["openai/gpt-6", "gpt-6"]) {
    const first = slashSuggestions(`/model ${typed}`, listed)[0]!;
    assert.deepEqual(slashModel(listed.models, typed), { model: gpt });
    assert.equal(first.draft, "/model openai/gpt-6", typed);
  }
});

test("/model takes a model's reference, its ID or its name, or enough of one to tell it apart", () => {
  const models = [sonnet, opus, relayed, gpt];
  assert.deepEqual(slashModel(models, "anthropic/claude-sonnet"), { model: sonnet });
  assert.deepEqual(slashModel(models, " Relay/Claude-Sonnet "), { model: relayed });
  assert.deepEqual(slashModel(models, "claude-opus"), { model: opus });
  assert.deepEqual(slashModel(models, "gpt-6"), { model: gpt });
  assert.deepEqual(slashModel(models, "claude sonnet"), { model: sonnet });
  assert.deepEqual(slashModel(models, "opus"), { model: opus });
  assert.deepEqual(slashModel(models, "relay"), { model: relayed });
  assert.deepEqual(slashModel(models, "llama"), { error: 'This session\'s host offers no model matching "llama".' });
  assert.deepEqual(slashModel(models, "claude-sonnet"), { error: '"claude-sonnet" matches 2 models (anthropic/claude-sonnet, relay/claude-sonnet). Type more of its name.' });
  assert.deepEqual(slashModel(models, ""), { error: "Name a model after /model, such as /model provider/model." });
  const many = Array.from({ length: 7 }, (_, index) => ({ provider: "relay", modelId: `m${index}`, name: `Model ${index}` }));
  assert.deepEqual(slashModel(many, "relay"), { error: '"relay" matches 7 models (relay/m0, relay/m1, relay/m2, relay/m3, relay/m4, …). Type more of its name.' });
});

test("/thinking takes a level by its name or its label, among the levels the model offers", () => {
  assert.equal(slashLevel(offer.levels, "high"), "high");
  assert.equal(slashLevel(offer.levels, "XHIGH"), "xhigh");
  assert.equal(slashLevel(offer.levels, "Extra high"), "xhigh");
  assert.equal(slashLevel(offer.levels, "extra-high"), "xhigh");
  assert.equal(slashLevel(offer.levels, "medium"), undefined);
  assert.equal(slashLevel(offer.levels, "hi"), undefined);
  assert.equal(slashLevel(offer.levels, ""), undefined);
});
