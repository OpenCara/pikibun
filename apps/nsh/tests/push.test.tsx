import { describe, expect, open, test } from "nsh/test";
import { pushedRoute } from "../src/lib/notifications";
import { ORIGIN, server, signedIn, user } from "./fixtures";

type Request = { method: string; url: string; body?: string | null };
const EXPO = "https://exp.host/--/api/v2/push/getExpoPushToken";
const expoToken = (device: string) => `ExponentPushToken[${device.padEnd(22, "x")}]`;
const phone = { id: "d-phone", kind: "expo", name: "iPhone", createdAt: "2026-11-20T10:00:00.000Z", current: true };
const preferences = { approvals: true, finished: true, failed: true, details: true };

const bodies = (app: { requests(): Request[] }, method: string, url: string) =>
  app.requests().filter(item => item.method === method && item.url === url).map(item => JSON.parse(item.body ?? "{}") as Record<string, unknown>);
const said = (app: { texts(): string[] }) => app.texts().filter(line => line.startsWith("push ")).map(line => line.slice(5));

interface Options {
  on?: boolean;
  params?: Record<string, unknown>;
  network?: Record<string, unknown>;
  clock?: boolean;
  shown?: { id: string }[];
}

async function openPhone(options: Options = {}) {
  let permission = options.on ? "granted" : "default";
  let registered = Boolean(options.on);
  const app = await open("./harness/push.tsx", {
    platform: "ios", host: { params: options.params ?? {} }, ...(options.clock ? { clock: {} } : {}),
    storage: { ...signedIn, ...(options.on ? { [`pikibun.notifications.${user.id}`]: "on", [`pikibun.notificationDevice.${user.id}`]: phone.id } : {}) },
    network: server({
      [`POST ${EXPO}`]: (request: Request) => ({ body: { data: { expoPushToken: expoToken((JSON.parse(request.body ?? "{}") as { deviceToken: string }).deviceToken) } } }),
      [`GET ${ORIGIN}/api/notifications/config`]: () => ({ body: { preferences, devices: registered ? [phone] : [], webPushKey: null } }),
      [`POST ${ORIGIN}/api/notifications/devices`]: () => { registered = true; return { status: 201, body: { device: phone } }; },
      [`DELETE ${ORIGIN}/api/notifications/devices/${phone.id}`]: () => { registered = false; return { body: { ok: true } }; },
      ...options.network,
    }),
    modules: { nsh: {
      "Notifications.permission": () => permission,
      "Notifications.requestPermission": () => (permission = "granted"),
      "Notifications.show": (notification: { id: string }) => { options.shown?.push(notification); return true; },
    } },
  });
  await app.waitFor("id:session-row-s1");
  return app;
}

async function openNotifications(app: Awaited<ReturnType<typeof openPhone>>) {
  await app.press("id:open-settings");
  await app.press("id:settings-section-notifications");
  await app.waitFor("id:notifications-device-toggle");
}

describe("pushes on iPhone", () => {
  test("turning notifications on registers the device with Expo and the server, and again when its token changes", async () => {
    const app = await openPhone();
    await openNotifications(app);
    expect(app.texts().join(" ")).toContain("This app gets notifications while it's closed too");
    await app.press("id:notifications-device-toggle");
    await app.waitFor("text:Notifications are on for this device.");
    const [asked] = bodies(app, "POST", EXPO);
    expect(asked).toMatchObject({ type: "apns", development: true, appId: "com.pikibun.app", deviceToken: "a1b2c3", projectId: "a8f1f8fe-f8a6-446d-8864-a8bc5df1e437" });
    expect(String(asked!.deviceId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(app.storage()["pikibun.pushInstall"]).toBe(asked!.deviceId);
    expect(bodies(app, "POST", `${ORIGIN}/api/notifications/devices`)[0]).toEqual({ kind: "expo", token: expoToken("a1b2c3"), name: "iPhone" });
    expect(app.storage()[`pikibun.notificationDevice.${user.id}`]).toBe(phone.id);
    expect(app.storage()[`pikibun.notifications.${user.id}`]).toBe("on");
    await app.waitFor("text:iPhone · This device");

    await app.press("id:fake-push-token");
    await app.waitUntil(() => bodies(app, "POST", `${ORIGIN}/api/notifications/devices`).some(body => body.token === expoToken("ffee00")));
    expect(bodies(app, "POST", EXPO).map(body => body.deviceId)).toEqual(bodies(app, "POST", EXPO).map(() => asked!.deviceId));

    await app.press("id:notifications-device-toggle");
    await app.waitFor("text:Notifications are off for this device.");
    expect(app.requests().some(item => item.method === "DELETE" && item.url === `${ORIGIN}/api/notifications/devices/${phone.id}`)).toBe(true);
    expect(app.storage()[`pikibun.notificationDevice.${user.id}`]).toBe(undefined);
  });

  test("each launch registers the device again, and a pressed push opens its session, which then gets no banner while it is in front", async () => {
    const app = await openPhone({ on: true, params: { press: { aps: { alert: { title: "Fix the flaky login test" }, "thread-id": "s1" }, body: { path: "/#/s/s1", origin: ORIGIN, sessionId: "s1" } } } });
    await app.waitUntil(() => bodies(app, "POST", `${ORIGIN}/api/notifications/devices`).length > 0);
    expect(bodies(app, "POST", `${ORIGIN}/api/notifications/devices`)).toEqual([{ kind: "expo", token: expoToken("a1b2c3"), name: "iPhone" }]);
    expect(app.shows("id:composer-input")).toBe(false);
    await app.press("id:fake-push-press");
    await app.waitFor("id:composer-input");
    await app.waitUntil(() => said(app).includes("quiet s1"));
    await app.press("id:header-back");
    await app.waitUntil(() => said(app).includes("shown s1"));
  });

  test("a push that names no page of the app opens nothing", () => {
    expect(pushedRoute({ aps: {}, body: { path: "/#/s/s1", origin: ORIGIN } })).toEqual({ route: { name: "session", sessionId: "s1" }, origin: ORIGIN });
    expect(pushedRoute({ aps: {}, body: { path: "/#/settings/notifications" } })).toEqual({ route: { name: "settings", section: "notifications" } });
    for (const payload of [null, "x", {}, { aps: {} }, { body: "x" }, { body: {} }, { body: { path: "https://evil.example/#/s/s1" } }, { body: { path: 7 } }, { path: "/#/s/s1" }]) {
      expect(pushedRoute(payload)).toBe(null);
    }
  });

  test("while it is open the app shows from the feed only what it took before the push went out", async () => {
    const shown: { id: string }[] = [];
    let fed = 0;
    const notification = (id: string, more: Record<string, unknown> = {}) => ({ id, kind: "finished", title: `Finished ${id}`, body: "The agent finished.", sessionId: "s9", createdAt: "2026-11-20T10:00:00.000Z", ...more });
    const app = await openPhone({ on: true, clock: true, shown, network: {
      [`GET ${ORIGIN}/api/notifications/feed*`]: () => (fed++ === 0 ? { body: { notifications: [], cursor: "c1" } }
        : fed === 2 ? { body: { notifications: [notification("n1", { pushed: true }), notification("n2"), notification("n3")], cursor: "c2" } }
        : { body: { notifications: [], cursor: "c2" } }),
      [`POST ${ORIGIN}/api/notifications/handled`]: { body: { handled: ["n2"] } },
    } });
    await app.clock!.runFor(25_000);
    await app.waitUntil(() => shown.length > 0);
    await app.clock!.runFor(25_000);
    expect(bodies(app, "POST", `${ORIGIN}/api/notifications/handled`)).toEqual([{ ids: ["n2", "n3"] }]);
    expect(shown.map(item => item.id)).toEqual(["n2 #/s/s9"]);
  });

  test("a device Apple doesn't register still shows notifications while the app is open, and says why it gets none closed", async () => {
    const app = await openPhone({ params: { refuses: true } });
    await openNotifications(app);
    await app.press("id:notifications-device-toggle");
    await app.waitFor("text:Notifications are on for this device.");
    expect(app.texts().join(" ")).toContain("It can't get them while it's closed yet: no valid aps-environment entitlement string found for application");
    expect(bodies(app, "POST", `${ORIGIN}/api/notifications/devices`)).toEqual([]);
    expect(app.storage()[`pikibun.notifications.${user.id}`]).toBe("on");
  });
});
