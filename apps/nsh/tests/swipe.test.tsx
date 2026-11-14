import { describe, expect, open, test } from "nsh/test";
import { swipeRest } from "../src/ui";
import { ORIGIN, server, sessionRecord, signedIn, workspace } from "./fixtures";

const asked = (app: { requests(): { method: string; url: string }[] }, method: string, url: string) => app.requests().some(item => item.method === method && item.url === url);

const phone = (overrides: Record<string, unknown> = {}) => open("../App.tsx", { network: server(overrides), storage: signedIn });

const second = { ...sessionRecord, id: "s3", title: "Tidy the README", createdAt: "2026-11-06T08:00:00.000Z" };
const twoSessions = { [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, second] } } };

describe("swiping a session's row on a phone", () => {
  test("left shows More and Archive, and Archive archives it once confirmed", async () => {
    const app = await phone({ [`POST ${ORIGIN}/api/sessions/s1/archive`]: { body: { ok: true } } });
    await app.waitFor("id:session-row-s1");
    expect(app.shows("id:swipe-more-s1")).toBe(false);
    await app.drag("id:session-row-s1", { x: -160 });
    await app.waitFor("id:swipe-archive-s1");
    expect(app.shows("id:swipe-more-s1")).toBe(true);
    expect(app.shows("id:swipe-copy-link-s1")).toBe(false);

    app.onDialog(dialog => (dialog.title === "Archive session?" ? "Archive" : null));
    await app.press("id:swipe-archive-s1");
    await app.waitUntil(() => asked(app, "POST", `${ORIGIN}/api/sessions/s1/archive`));
    await app.waitFor("text:Session archived");
    await app.waitUntil(() => !app.shows("id:swipe-archive-s1"));
  });

  test("left's More opens the row's whole menu", async () => {
    const app = await phone();
    await app.waitFor("id:session-row-s1");
    await app.drag("id:session-row-s1", { x: -160 });
    await app.press("id:swipe-more-s1");
    await app.waitFor("id:menu-copy-id");
    for (const item of ["menu-copy-link", "menu-rename", "menu-visibility", "menu-archive"]) expect(app.shows(`id:${item}`)).toBe(true);
    await app.press("id:menu-copy-id");
    expect(app.clipboard()).toBe("s1");
    expect(app.shows("id:session-actions")).toBe(false);
  });

  test("right shows Copy link and Rename", async () => {
    const app = await phone();
    await app.waitFor("id:session-row-s1");
    await app.drag("id:session-row-s1", { x: 160 });
    await app.waitFor("id:swipe-copy-link-s1");
    expect(app.shows("id:swipe-archive-s1")).toBe(false);
    await app.press("id:swipe-copy-link-s1");
    expect(app.clipboard()).toBe(`${ORIGIN}/#/s/s1`);
    await app.waitFor("text:Link copied");
    await app.waitUntil(() => !app.shows("id:swipe-copy-link-s1"));

    await app.drag("id:session-row-s1", { x: 160 });
    await app.press("id:swipe-rename-s1");
    await app.waitFor("id:rename-title");
    expect(app.value("id:rename-title")).toBe(sessionRecord.title);
  });

  test("an archived session's left swipe unarchives it", async () => {
    const app = await phone({ [`POST ${ORIGIN}/api/sessions/s2/unarchive`]: { body: { ok: true } } });
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-archived-w1");
    await app.waitFor("id:session-row-s2");
    await app.drag("id:session-row-s2", { x: -160 });
    await app.waitFor("id:swipe-unarchive-s2");
    expect(app.shows("id:swipe-archive-s2")).toBe(false);
    await app.drag("id:session-row-s2", { x: 160 });
    await app.waitFor("id:swipe-copy-link-s2");
    expect(app.shows("id:swipe-rename-s2")).toBe(false);
    await app.drag("id:session-row-s2", { x: -160 });
    await app.press("id:swipe-unarchive-s2");
    await app.waitUntil(() => asked(app, "POST", `${ORIGIN}/api/sessions/s2/unarchive`));
  });

  test("a short flick opens it, a flick back shuts it, and a tap on an open row closes it without opening the session", async () => {
    const app = await phone();
    await app.waitFor("id:session-row-s1");
    await app.drag("id:session-row-s1", { x: -30 });
    await app.waitFor("id:swipe-more-s1");
    await app.drag("id:session-row-s1", { x: 30 });
    await app.waitUntil(() => !app.shows("id:swipe-more-s1"));
    expect(app.shows("id:swipe-copy-link-s1")).toBe(false);

    await app.drag("id:session-row-s1", { x: -30 });
    await app.waitFor("id:swipe-more-s1");
    await app.press("id:session-row-s1");
    await app.waitUntil(() => !app.shows("id:swipe-more-s1"));
    expect(app.shows("id:session-actions")).toBe(false);
    await app.press("id:session-row-s1");
    await app.waitFor("id:session-actions");
  });

  test("opening another row closes the one open", async () => {
    const app = await phone(twoSessions);
    await app.waitFor("id:session-row-s3");
    await app.drag("id:session-row-s1", { x: -160 });
    await app.waitFor("id:swipe-more-s1");
    await app.drag("id:session-row-s3", { x: 160 });
    await app.waitFor("id:swipe-copy-link-s3");
    await app.waitUntil(() => !app.shows("id:swipe-more-s1"));
  });

  test("a vertical drag scrolls the list rather than sliding the row, and closes the row open", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...sessionRecord, id: `m${index}`, title: `Session ${index}` }));
    const app = await phone({ [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: many } } });
    await app.waitFor("id:session-row-m1");
    await app.drag("id:session-row-m1", { y: -120 });
    await app.wait(300);
    expect(app.shows("id:swipe-more-m1")).toBe(false);
    expect(app.shows("id:swipe-copy-link-m1")).toBe(false);

    await app.waitFor("id:session-row-m5");
    await app.drag("id:session-row-m5", { x: -160 });
    await app.waitFor("id:swipe-more-m5");
    await app.drag("id:session-row-m6", { y: 60 });
    await app.waitUntil(() => !app.shows("id:swipe-more-m5"));
  });

  test("offers Unarchive on someone else's packed session to whoever manages it, as its host unpacks it as its owner", async () => {
    const packed = { ...sessionRecord, id: "s6", ownerId: "u2", title: "Packed spike", status: "archived", activity: "idle", packed: true };
    const app = await phone({ [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, packed] } } });
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-archived-w1");
    await app.waitFor("id:session-row-s6");
    await app.drag("id:session-row-s6", { x: -160 });
    await app.waitFor("id:swipe-more-s6");
    expect(app.shows("id:swipe-unarchive-s6")).toBe(true);
    await app.press("id:swipe-more-s6");
    await app.waitFor("id:menu-unarchive");
    expect(app.shows("text:Its files are packed: only its owner can")).toBe(false);
  });

  test("an open row keeps showing the tiles it still has when they change", async () => {
    const team = { id: "w2", name: "Difference Engine", ownerId: "u2", role: "member" };
    let handedOver = false;
    const mine = () => ({ ...sessionRecord, id: "s7", workspaceId: "w2", ownerId: handedOver ? "u2" : "u1", title: "Busy work", activity: "working" });
    const app = await phone({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace, team] } },
      [`GET ${ORIGIN}/api/sessions`]: () => ({ body: { sessions: [mine()] } }),
    });
    await app.waitFor("id:session-row-s7");
    await app.drag("id:session-row-s7", { x: 160 });
    await app.waitFor("id:swipe-rename-s7");
    handedOver = true;
    await app.waitUntil(() => !app.shows("id:swipe-rename-s7"), { timeout: 15_000 });
    expect(app.shows("id:swipe-copy-link-s7")).toBe(true);
  });

  test("offers only copying its link and the menu to someone who doesn't manage the session", async () => {
    const team = { id: "w2", name: "Difference Engine", ownerId: "u2", role: "member" };
    const theirs = { ...sessionRecord, id: "s5", workspaceId: "w2", ownerId: "u2", title: "Babbage's notes", visibility: "workspace", permissions: ["read"] };
    const app = await phone({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace, team] } },
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, theirs] } },
    });
    await app.waitFor("id:session-row-s5");
    await app.drag("id:session-row-s5", { x: -160 });
    await app.waitFor("id:swipe-more-s5");
    expect(app.shows("id:swipe-archive-s5")).toBe(false);
    await app.drag("id:session-row-s5", { x: 160 });
    await app.waitFor("id:swipe-copy-link-s5");
    expect(app.shows("id:swipe-rename-s5")).toBe(false);
  });
});

test("a let-go swipe rests open past half its tiles or flicked toward them, else shut", () => {
  expect(swipeRest(-30, 0, 72, 144)).toBe(0);
  expect(swipeRest(-80, 0, 72, 144)).toBe(-144);
  expect(swipeRest(-200, 0, 72, 144)).toBe(-144);
  expect(swipeRest(-30, -600, 72, 144)).toBe(-144);
  expect(swipeRest(-100, 600, 72, 144)).toBe(0);
  expect(swipeRest(30, 0, 72, 144)).toBe(0);
  expect(swipeRest(40, 0, 72, 144)).toBe(72);
  expect(swipeRest(20, 600, 72, 144)).toBe(72);
  expect(swipeRest(60, -600, 72, 144)).toBe(0);
  expect(swipeRest(100, 900, 0, 144)).toBe(0);
  expect(swipeRest(-100, -900, 72, 0)).toBe(0);
});

test("a session's row doesn't slide on a desktop, which has its right-click menu", async () => {
  const app = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
  await app.waitFor("id:session-row-s1");
  await app.drag("id:session-row-s1", { x: -160 });
  await app.wait(300);
  expect(app.shows("id:swipe-more-s1")).toBe(false);
  expect(app.shows("id:swipe-archive-s1")).toBe(false);
});
