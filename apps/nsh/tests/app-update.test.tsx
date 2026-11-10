import { describe, expect, open, test } from "nsh/test";
import {
  assetSuffix, compareVersions, newerRelease, RELEASES_API, updatesFolder, utf16le, windowsInstallerArguments, windowsUpdateTask,
} from "../src/lib/app-update";
import { server, signedIn } from "./fixtures";

const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  name, size: 22_931_985, state: "uploaded", digest: `sha256:${"ab".repeat(32)}`,
  browser_download_url: `https://evil.example/${name}`, ...extra,
});
const release = (tag: string, extra: Record<string, unknown> = {}) => {
  const version = tag.replace(/^[a-z]+-v/, "");
  return {
    tag_name: tag, draft: false, prerelease: false,
    assets: [
      asset(`Pikibun-${version}-macos-arm64.dmg`), asset(`Pikibun-${version}-windows-x64-setup.exe`, { size: 16_493_012 }),
      asset(`Pikibun-${version}-linux-x86_64.tar.gz`, { size: 21_444_047 }), asset(`Pikibun-${version}-android.apk`),
    ],
    ...extra,
  };
};
const releases = [
  release("server-v0.30.0"), release("app-v0.18.0-beta.1", { prerelease: true }), release("app-v0.19.0", { draft: true }),
  release("app-v0.17.0"), release("app-v0.16.0"), release("cli-v0.40.0"),
];

describe("finding a newer release", () => {
  test("compares semantic versions, a prerelease before its release", () => {
    expect(compareVersions("0.17.0", "0.16.0")).toBe(1);
    expect(compareVersions("0.16.0", "0.16.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("dev", "0.16.0")).toBe(undefined);
  });

  test("takes the newest published app-v release, never a draft, a prerelease or another line's", () => {
    const update = newerRelease(releases, "0.16.0", "macos", "aarch64");
    expect(update).toEqual({
      version: "0.17.0", tag: "app-v0.17.0", page: "https://github.com/OpenCara/pikibun/releases/tag/app-v0.17.0",
      asset: {
        name: "Pikibun-0.17.0-macos-arm64.dmg", size: 22_931_985, sha256: "ab".repeat(32),
        url: "https://github.com/OpenCara/pikibun/releases/download/app-v0.17.0/Pikibun-0.17.0-macos-arm64.dmg",
      },
    });
    expect(newerRelease(releases, "0.17.0", "macos", "aarch64")).toBe(undefined);
    expect(newerRelease(releases, "0.18.0", "macos", "aarch64")).toBe(undefined);
  });

  test("offers prereleases only to a prerelease", () => {
    expect(newerRelease(releases, "0.18.0-alpha.1", "windows", "x86_64")?.version).toBe("0.18.0-beta.1");
    expect(newerRelease([release("app-v0.20.0-rc.1")], "0.17.0", "windows", "x86_64")).toBe(undefined);
  });

  test("picks this computer's package, and the release page where the release has none", () => {
    expect(newerRelease(releases, "0.16.0", "windows", "x86_64")?.asset?.name).toBe("Pikibun-0.17.0-windows-x64-setup.exe");
    expect(newerRelease(releases, "0.16.0", "linux", "x86_64")?.asset?.size).toBe(21_444_047);
    expect(newerRelease(releases, "0.16.0", "macos", "x86_64")).toMatchObject({ version: "0.17.0", asset: null });
    expect(newerRelease([release("app-v0.17.0", { assets: [] })], "0.16.0", "macos", "aarch64")?.asset).toBe(null);
    expect(newerRelease([release("app-v0.17.0", { assets: [asset("Pikibun-0.17.0-macos-arm64.dmg", { state: "starter" })] })], "0.16.0", "macos", "aarch64")?.asset).toBe(null);
    expect(newerRelease([release("app-v0.17.0", { assets: [asset("Pikibun-0.17.0-macos-arm64.dmg", { digest: null })] })], "0.16.0", "macos", "aarch64")?.asset?.sha256).toBe(undefined);
    expect(assetSuffix("ios", "aarch64")).toBe(null);
  });

  test("a development build never asks", () => {
    expect(newerRelease(releases, "dev", "macos", "aarch64")).toBe(undefined);
    expect(newerRelease({ message: "API rate limit exceeded" }, "0.16.0", "macos", "aarch64")).toBe(undefined);
  });
});

describe("installing on Windows", () => {
  test("Task Scheduler runs the installer outside the app, silently, and it starts Pikibun again", () => {
    const xml = windowsUpdateTask("C:\\Users\\Ada & Co\\AppData\\Roaming\\com.pikibun.app\\updates\\Pikibun-0.17.0-windows-x64-setup.exe",
      "C:\\Users\\Ada & Co\\AppData\\Roaming\\com.pikibun.app\\updates\\install.log", "LAB\\ada");
    expect(xml).toContain("<Command>C:\\Users\\Ada &amp; Co\\AppData\\Roaming\\com.pikibun.app\\updates\\Pikibun-0.17.0-windows-x64-setup.exe</Command>");
    expect(xml).toContain("<Arguments>/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /RELAUNCH /LOG=&quot;C:\\Users\\Ada &amp; Co\\AppData\\Roaming\\com.pikibun.app\\updates\\install.log&quot;</Arguments>");
    expect(xml).toContain("<UserId>LAB\\ada</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(windowsUpdateTask("C:\\setup.exe", "C:\\install.log")).toContain("<Principal id=\"Author\"><LogonType>InteractiveToken</LogonType>");
    expect(windowsInstallerArguments("C:\\x.log")).toBe("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /RELAUNCH /LOG=\"C:\\x.log\"");
  });

  test("writes the task as UTF-16, as its XML declaration says", () => {
    expect(Array.from(utf16le("Aé"))).toEqual([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00]);
  });

  test("downloads into the app's own data folder", () => {
    expect(updatesFolder("windows", "C:\\Users\\Ada\\AppData\\Roaming\\com.pikibun.app\\")).toBe("C:\\Users\\Ada\\AppData\\Roaming\\com.pikibun.app\\updates");
    expect(updatesFolder("macos", "/Users/ada/Library/Application Support/com.pikibun.app")).toBe("/Users/ada/Library/Application Support/com.pikibun.app/updates");
    expect(updatesFolder("linux", null)).toBe(null);
  });
});

async function openUpdater(params: Record<string, unknown> = {}, list: unknown = releases) {
  const app = await open("./harness/app-update.tsx", {
    platform: "macos", width: 900, height: 1400, host: { params },
    network: { [`GET ${RELEASES_API}`]: { body: list } },
  });
  const sent = () => app.texts().filter(text => text.startsWith("sent ")).map(text => text.slice("sent ".length));
  const showsText = (part: string) => app.texts().some(text => text.includes(part));
  return { app, sent, showsText };
}

describe("updating the app", () => {
  test("a newer release shows in the sidebar; its button downloads it with progress, installs it and restarts", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "paused" });
    await app.waitFor("id:sidebar-update-button");
    expect(app.shows("text:Update to 0.17.0")).toBe(true);
    expect(showsText("Pikibun 0.17.0 is available")).toBe(true);
    await app.press("id:sidebar-update-button");
    await app.waitUntil(() => showsText("Downloading Pikibun 0.17.0… 50%"));
    expect(app.shows("id:sidebar-update-progress-bar")).toBe(true);
    expect(showsText("10.9 MB of 21.9 MB")).toBe(true);
    expect(app.shows("id:sidebar-update-button")).toBe(false);
    expect(sent().some(line => line.startsWith("install "))).toBe(false);
    await app.press("id:fake-download-continue");
    await app.waitUntil(() => sent().includes("restart"));
    expect(sent()).toEqual([
      "clean up 0.16.0",
      `download https://github.com/OpenCara/pikibun/releases/download/app-v0.17.0/Pikibun-0.17.0-macos-arm64.dmg ${"ab".repeat(32)}`,
      "install /Users/ada/Library/Application Support/com.pikibun.app/updates/Pikibun-0.17.0-macos-arm64.dmg 0.17.0",
      "restart",
    ]);
    expect(showsText("Restarting Pikibun…")).toBe(true);
  });

  test("Settings updates the same way", async () => {
    const { app, sent } = await openUpdater({}, releases);
    await app.waitFor("id:app-update-button");
    await app.press("id:app-update-button");
    await app.waitUntil(() => sent().includes("restart"));
  });

  test("a failed update says why, and can be tried again", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "install-fails" });
    await app.waitFor("id:app-update-button");
    await app.press("id:app-update-button");
    await app.waitFor("id:app-update-failed");
    expect(showsText("/Applications can't be written by ada")).toBe(true);
    expect(app.shows("id:sidebar-update-error")).toBe(true);
    expect(sent()).not.toContain("restart");
    await app.press("id:app-update-retry");
    await app.waitUntil(() => sent().filter(line => line.startsWith("install ")).length === 2);
  });

  test("a download that doesn't match GitHub's checksum installs nothing", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "download-fails" });
    await app.waitFor("id:sidebar-update-button");
    await app.press("id:sidebar-update-button");
    await app.waitFor("id:app-update-failed");
    expect(showsText("doesn't match the checksum")).toBe(true);
    expect(sent().some(line => line.startsWith("install "))).toBe(false);
  });

  test("up to date, it says so, and checks again on demand", async () => {
    const { app, showsText } = await openUpdater({ current: "0.17.0" });
    await app.waitUntil(() => showsText("Pikibun is up to date"));
    expect(app.shows("id:sidebar-update")).toBe(false);
    expect(showsText("Pikibun 0.17.0")).toBe(true);
    await app.press("id:app-update-check-button");
    await app.waitUntil(() => showsText("Pikibun is up to date"));
  });

  test("a release without this computer's package points to its page", async () => {
    const { app } = await openUpdater({ arch: "x86_64" });
    await app.waitFor("id:app-update-page");
    expect(app.shows("id:app-update-button")).toBe(false);
  });

  test("says when GitHub can't be asked", async () => {
    const { app, showsText } = await openUpdater({}, { message: "API rate limit exceeded" });
    await app.waitUntil(() => showsText("Couldn't check for updates"));
  });

  test("after the restart, says the update went in, or that it didn't", async () => {
    const done = await openUpdater({ cleanUp: "installed", current: "0.17.0" });
    await done.app.waitFor("id:app-update-notice");
    expect(done.showsText("Pikibun was updated to 0.17.0.")).toBe(true);
    const failed = await openUpdater({ cleanUp: "failed" });
    await failed.app.waitFor("id:app-update-failed");
    expect(failed.showsText("The update to 0.17.0 didn't install.")).toBe(true);
  });

  test("a development build offers no update", async () => {
    const { app, sent, showsText } = await openUpdater({ current: "dev" });
    await app.waitFor("id:app-version");
    expect(showsText("Pikibun (development build)")).toBe(true);
    expect(app.shows("id:app-update-check")).toBe(false);
    expect(sent()).toEqual([]);
  });

  test("phones and the web offer none either", async () => {
    const { app, sent } = await openUpdater({ os: "ios" });
    await app.waitFor("id:app-version");
    expect(app.shows("id:app-update-check")).toBe(false);
    expect(sent()).toEqual([]);
  });

  test("the app shows its version under Profile", async () => {
    const mac = await open("../App.tsx", { network: server(), storage: signedIn, platform: "macos", width: 1280, height: 1600 });
    await mac.waitFor("id:session-row-s1");
    await mac.press("id:open-profile");
    await mac.waitFor("id:app-version");
    expect(mac.shows("id:sidebar-update")).toBe(false);
  });
});
