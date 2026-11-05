import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const globals = globalThis as unknown as { localStorage: MemoryStorage; sessionStorage: MemoryStorage };
globals.localStorage = new MemoryStorage();
globals.sessionStorage = new MemoryStorage();

const { forgetSentDraft, newSessionDraftId, readDraft, restoreDraft, writeDraft } = await import("../apps/web/src/drafts");

beforeEach(() => { globals.localStorage.clear(); globals.sessionStorage.clear(); });

test("a workspace's new-session draft outlives the screen, apart from other workspaces and sessions", () => {
  const first = newSessionDraftId("workspace-1");
  const second = newSessionDraftId("workspace-2");
  assert.notEqual(first, second);
  writeDraft(first, "Fix the flaky test");
  writeDraft("0b6f6c1e-9d7a-4a3e-8f53-3c2b1a0d9e8f", "a session's own draft");
  // Coming back to the new-session screen of the workspace finds the text where it was left.
  assert.equal(readDraft(first), "Fix the flaky test");
  assert.equal(readDraft(second), "");
});

test("a message handed back to the chat box goes below what is typed there, not instead of it or nowhere", () => {
  const id = "0b6f6c1e-9d7a-4a3e-8f53-3c2b1a0d9e8f";
  // An empty box takes the message as it is.
  restoreDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "Fix the flaky test");

  // A box that already holds text keeps it, with the message below.
  writeDraft(id, "and update the docs");
  restoreDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "and update the docs\n\nFix the flaky test");

  // Only whitespace counts as empty.
  writeDraft(id, "  \n");
  restoreDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "Fix the flaky test");

  // A message that was only images brings no text back: what is typed stays as it is, without a blank gap below it.
  writeDraft(id, "and update the docs");
  restoreDraft(id, "");
  assert.equal(readDraft(id), "and update the docs");
});

test("starting the session forgets the new-session draft, unless it was edited meanwhile", () => {
  const id = newSessionDraftId("workspace-1");
  writeDraft(id, "Fix the flaky test");
  forgetSentDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "");

  writeDraft(id, "Fix the flaky test, and the other one");
  forgetSentDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "Fix the flaky test, and the other one");
});
