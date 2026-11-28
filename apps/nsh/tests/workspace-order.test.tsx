import { describe, expect, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, workspace } from "./fixtures";

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

  test("a workspace dropped between two others lands there, after the sidebar's rows changed and after a first move", async () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
    const many = [personal, ...numbers.map(n => ({ id: `w${n}`, name: `Workspace ${n}`, ownerId: "u1", role: "owner" }))];
    const sessions = numbers.flatMap(n => [1, 2, 3].map(k => ({ ...sessionRecord, id: `s${n}-${k}`, workspaceId: `w${n}`, title: `Session ${n}.${k}` })));
    const app = await open("../App.tsx", { storage: signedIn, platform: "macos", width: 1280, height: 600, network: server({
      [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: many } },
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions } },
      [`PUT ${ORIGIN}/api/workspaces/order`]: (request: Request) => ({
        body: { workspaces: [personal, ...(JSON.parse(request.body ?? "{}").workspaceIds as string[]).map(id => many.find(item => item.id === id)!)] } }),
    }) });
    await app.waitFor("id:workspace-row-w1");
    for (const n of numbers) {
      await app.waitFor(`id:workspace-row-w${n}`);
      await app.press(`id:workspace-row-w${n}`);
    }
    await app.waitFor("id:workspace-row-w8");

    await app.drag("id:workspace-row-w8", { y: -110 });
    await app.waitUntil(() => orders(app).length === 1);
    expect(orders(app)[0]).toEqual(["w1", "w2", "w3", "w4", "w5", "w8", "w6", "w7"]);
    await app.waitUntil(() => app.texts().indexOf("Workspace 8") < app.texts().indexOf("Workspace 6"));

    await app.drag("id:workspace-row-w1", { y: 100 });
    await app.waitUntil(() => orders(app).length === 2);
    expect(orders(app)[1]).toEqual(["w2", "w3", "w1", "w4", "w5", "w8", "w6", "w7"]);
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

describe("hiding workspaces", () => {
  const hides = (app: App) => app.requests().filter(item => item.method === "PUT" && item.url.endsWith("/hidden"))
    .map(item => ({ id: item.url.split("/").at(-2), hidden: JSON.parse(item.body ?? "{}").hidden as boolean }));
  const hiding = (start: readonly string[] = [], answer?: (count: number) => Record<string, unknown> | undefined) => {
    let hidden = new Set(start);
    let count = 0;
    const current = () => listed.map(item => (hidden.has(item.id) ? { ...item, hidden: true } : item));
    return server({
      [`GET ${ORIGIN}/api/workspaces`]: () => ({ body: { workspaces: current() } }),
      [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [
        { ...sessionRecord, id: "s-loom", workspaceId: "w3", title: "Weave the pattern" },
        { ...sessionRecord, id: "s-engine", workspaceId: "w1", title: "Compute the table" },
      ] } },
      [`PUT ${ORIGIN}/api/workspaces/order`]: saved,
      ...Object.fromEntries(listed.map(item => [`PUT ${ORIGIN}/api/workspaces/${item.id}/hidden`, (request: Request) => {
        const refused = answer?.(++count);
        if (refused) return refused;
        const next = JSON.parse(request.body ?? "{}").hidden as boolean;
        hidden = new Set([...hidden].filter(id => id !== item.id).concat(next ? [item.id] : []));
        return { body: { workspaces: current() } };
      }])),
    });
  };
  const desktop = { storage: signedIn, platform: "macos" as const, width: 1280, height: 820 };

  test("a workspace hidden from its menu leaves the sidebar, and the hidden row shows it again to bring it back", async () => {
    const app = await open("../App.tsx", { network: hiding(), ...desktop });
    await app.waitFor("id:workspace-options-w3");
    expect(app.shows("id:sidebar-hidden-workspaces")).toBe(false);
    await app.press("id:workspace-options-w3");
    await app.press("id:workspace-hide-w3");
    await app.waitUntil(() => !app.shows("id:workspace-row-w3"));
    expect(hides(app)).toEqual([{ id: "w3", hidden: true }]);
    expect(app.shows("text:Weave the pattern")).toBe(false);
    await app.waitFor("id:sidebar-hidden-workspaces");
    expect(app.shows("text:Hidden workspaces")).toBe(true);

    await app.press("id:sidebar-hidden-workspaces");
    await app.waitFor("id:workspace-row-w3");
    await app.press("id:workspace-options-w3");
    await app.press("id:workspace-hide-w3");
    await app.waitUntil(() => hides(app).length === 2);
    expect(hides(app)[1]).toEqual({ id: "w3", hidden: false });
    await app.waitUntil(() => !app.shows("id:sidebar-hidden-workspaces"));
    expect(app.shows("id:workspace-row-w3")).toBe(true);
  });

  test("the private workspace can't be hidden, and search still finds a hidden workspace's sessions", async () => {
    const app = await open("../App.tsx", { network: hiding(["w3"]), ...desktop });
    await app.waitFor("id:sidebar-hidden-workspaces");
    expect(app.shows("id:workspace-row-w3")).toBe(false);
    await app.press("id:workspace-options-w0");
    await app.waitFor("id:workspace-copy-id-w0");
    expect(app.shows("id:workspace-hide-w0")).toBe(false);
    await app.press("id:workspace-options-w0");

    await app.type("id:session-search", "weave");
    await app.waitFor("text:Weave the pattern");
    expect(app.shows("id:sidebar-hidden-workspaces")).toBe(false);
  });

  test("moving a workspace past a hidden one keeps the hidden one's place in the saved order", async () => {
    const app = await open("../App.tsx", { network: hiding(["w2"]), ...desktop });
    await app.waitFor("id:workspace-options-w1");
    expect(sidebar(app).slice(0, 3)).toEqual(["Private", "Analytical Engine", "Jacquard Loom"]);
    expect(app.shows("id:workspace-row-w2")).toBe(false);
    await app.press("id:workspace-options-w1");
    await app.press("id:workspace-move-down-w1");
    await app.waitUntil(() => orders(app).length === 1);
    expect(orders(app)[0]).toEqual(["w3", "w2", "w1"]);
  });

  test("a hide the server refuses says why, and the workspace comes back", async () => {
    const app = await open("../App.tsx", { network: hiding([], () => ({ status: 500, body: { error: "Could not hide it.", code: "internal" } })), ...desktop });
    await app.waitFor("id:workspace-options-w2");
    await app.press("id:workspace-options-w2");
    await app.press("id:workspace-hide-w2");
    await app.waitFor("id:workspace-order-feedback");
    await app.waitFor("id:workspace-row-w2");
    expect(app.shows("id:sidebar-hidden-workspaces")).toBe(false);
  });
});
