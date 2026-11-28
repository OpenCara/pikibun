import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, signedIn, workspace } from "./fixtures";

const personal = { id: "w0", name: "Private", ownerId: "u1", role: "owner", personal: true };
const second = { id: "w2", name: "Difference Engine", ownerId: "u1", role: "owner" };
const third = { id: "w3", name: "Jacquard Loom", ownerId: "u2", role: "member" };
const listed = [personal, workspace, second, third];
type Request = { method: string; url: string; body?: string | null };

const saved = (request: Request) => {
  const ids: string[] = JSON.parse(request.body ?? "{}").workspaceIds;
  return { body: { workspaces: [personal, ...ids.map(id => listed.find(item => item.id === id)!)] } };
};

const network = (put: (request: Request, count: number) => Record<string, unknown> = saved) => {
  let count = 0;
  return server({
    [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: listed } },
    [`PUT ${ORIGIN}/api/workspaces/order`]: (request: Request) => put(request, ++count),
  });
};

type App = Awaited<ReturnType<typeof open>>;
const orders = (app: App) => app.requests().filter(item => item.method === "PUT" && item.url === `${ORIGIN}/api/workspaces/order`)
  .map(item => JSON.parse(item.body ?? "{}").workspaceIds as string[]);
const sidebar = (app: App) => app.texts().filter(item => listed.some(entry => entry.name === item)).slice(0, listed.length);

describe("reordering workspaces", () => {
  test("a workspace's row dragged in the sidebar moves it, and the private workspace stays first", async () => {
    const app = await open("../App.tsx", { network: network(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:workspace-row-w3");
    expect(sidebar(app)).toEqual(["Private", "Analytical Engine", "Difference Engine", "Jacquard Loom"]);

    await app.dragAndHold("id:workspace-row-w3", { y: -500 });
    await app.waitFor("id:workspace-drop-line");
    await app.drop();
    await app.waitUntil(() => orders(app).length === 1);
    expect(app.shows("id:workspace-drop-line")).toBe(false);
    expect(orders(app)[0]).toEqual(["w3", "w1", "w2"]);
    await app.waitUntil(() => sidebar(app)[1] === "Jacquard Loom");
    expect(sidebar(app)).toEqual(["Private", "Jacquard Loom", "Analytical Engine", "Difference Engine"]);

    await app.drag("id:workspace-row-w0", { y: 400 });
    await app.drag("id:workspace-row-w2", { y: 4 });
    expect(orders(app).length).toBe(1);
    expect(sidebar(app)[0]).toBe("Private");
  });

  test("its menu moves it up or down, and the private workspace's has neither", async () => {
    const app = await open("../App.tsx", { network: network(), storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:workspace-options-w1");
    await app.press("id:workspace-options-w1");
    await app.waitFor("id:workspace-move-down-w1");
    expect(app.shows("id:workspace-move-up-w1")).toBe(false);
    await app.press("id:workspace-move-down-w1");
    await app.waitUntil(() => orders(app).length === 1);
    expect(orders(app)[0]).toEqual(["w2", "w1", "w3"]);
    await app.waitUntil(() => sidebar(app)[1] === "Difference Engine");

    await app.press("id:workspace-options-w0");
    await app.waitFor("id:workspace-copy-id-w0");
    expect(app.shows("id:workspace-move-up-w0")).toBe(false);
    expect(app.shows("id:workspace-move-down-w0")).toBe(false);
  });

  test("a second move while the first is still saving wins, whichever answer comes last", async () => {
    const app = await open("../App.tsx", { network: network((request, count) => ({ ...saved(request), ...(count === 1 ? { delay: 600 } : {}) })),
      storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:workspace-options-w1");
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-move-down-w1");
    await app.waitUntil(() => sidebar(app)[2] === "Analytical Engine");
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-move-down-w1");
    await app.waitUntil(() => orders(app).length === 2);
    expect(orders(app)).toEqual([["w2", "w1", "w3"], ["w2", "w3", "w1"]]);
    await app.waitUntil(() => sidebar(app)[3] === "Analytical Engine");
    await app.wait(800);
    expect(sidebar(app)).toEqual(["Private", "Difference Engine", "Jacquard Loom", "Analytical Engine"]);
  });

  test("a move the server refuses says why, and the sidebar goes back to the order it has", async () => {
    const app = await open("../App.tsx", { network: network(() => ({ status: 500, body: { error: "Could not save the order.", code: "internal" } })),
      storage: signedIn, platform: "macos", width: 1280, height: 820 });
    await app.waitFor("id:workspace-options-w1");
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-move-down-w1");
    await app.waitFor("id:workspace-order-feedback");
    expect(sidebar(app)).toEqual(["Private", "Analytical Engine", "Difference Engine", "Jacquard Loom"]);
  });

  test("on a phone, a workspace moves by its grip, and the private workspace has none", async () => {
    const app = await open("../App.tsx", { network: network(), storage: signedIn });
    await app.waitFor("id:workspace-drag-w1");
    expect(app.shows("id:workspace-drag-w0")).toBe(false);
    await app.drag("id:workspace-drag-w1", { y: 500 });
    await app.waitUntil(() => orders(app).length === 1);
    expect(orders(app)[0]).toEqual(["w2", "w3", "w1"]);
  });
});
