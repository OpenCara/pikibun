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

const { forgetSentDraft, newSessionDraftId, readDraft, writeDraft } = await import("../apps/web/src/drafts");

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

test("starting the session forgets the new-session draft, unless it was edited meanwhile", () => {
  const id = newSessionDraftId("workspace-1");
  writeDraft(id, "Fix the flaky test");
  forgetSentDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "");

  writeDraft(id, "Fix the flaky test, and the other one");
  forgetSentDraft(id, "Fix the flaky test");
  assert.equal(readDraft(id), "Fix the flaky test, and the other one");
});
