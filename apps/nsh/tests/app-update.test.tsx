import { describe, expect, open, test } from "nsh/test";
import { assetSuffix, compareVersions, newerRelease, preferProxy, ProxyDownloadFailed, RELEASES_API, updatesFolder } from "../src/lib/app-update";
import { curlArguments, gnomeProxy, proxyUrl, shellProxy, shownProxy, windowsProxy } from "../src/lib/update-proxy";
import { utf16le, windowsInstallerArguments, windowsUpdateTask } from "../src/lib/update-scripts";
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

  test("picks this computer's package, and the release page where the release has none, or none GitHub published a checksum for", () => {
    expect(newerRelease(releases, "0.16.0", "windows", "x86_64")?.asset?.name).toBe("Pikibun-0.17.0-windows-x64-setup.exe");
    expect(newerRelease(releases, "0.16.0", "linux", "x86_64")?.asset?.size).toBe(21_444_047);
    expect(newerRelease(releases, "0.16.0", "macos", "x86_64")).toMatchObject({ version: "0.17.0", asset: null });
    expect(newerRelease([release("app-v0.17.0", { assets: [] })], "0.16.0", "macos", "aarch64")?.asset).toBe(null);
    expect(newerRelease([release("app-v0.17.0", { assets: [asset("Pikibun-0.17.0-macos-arm64.dmg", { state: "starter" })] })], "0.16.0", "macos", "aarch64")?.asset).toBe(null);
    expect(newerRelease([release("app-v0.17.0", { assets: [asset("Pikibun-0.17.0-macos-arm64.dmg", { digest: null })] })], "0.16.0", "macos", "aarch64")?.asset).toBe(null);
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

describe("finding the proxy the download goes through", () => {
  const internetSettings = (values: string) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    CertificateRevocation    REG_DWORD    0x1\r\n${values}\r\n`;

  test("Windows' proxy settings, as Clash or Settings → Proxy write them", () => {
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n    ProxyOverride    REG_SZ    localhost;127.*;<local>"))).toBe("http://127.0.0.1:7890");
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=10.0.0.2:8080;https=10.0.0.2:8443;socks=10.0.0.2:1080"))).toBe("http://10.0.0.2:8443");
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080"))).toBe("socks4a://127.0.0.1:1080");
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890"))).toBe(null);
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1"))).toBe(null);
    expect(windowsProxy("")).toBe(null);
  });

  test("Windows' next proxy entry where the first can't be passed on", () => {
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    https=bad%host:1;http=127.0.0.1:8080"))).toBe("http://127.0.0.1:8080");
    expect(windowsProxy(internetSettings("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    https=bad%host:1;socks=127.0.0.1:1080"))).toBe("socks4a://127.0.0.1:1080");
  });

  test("a proxy's password is never shown", () => {
    expect(shownProxy("http://ada:secret@proxy.lan:3128")).toBe("http://…@proxy.lan:3128");
    expect(shownProxy("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  test("a proxy that doesn't carry the download leaves it to the direct one, as before", async () => {
    const tried: string[] = [];
    const direct = (outcome: "ok" | "fails") => async () => {
      tried.push("direct");
      if (outcome === "fails") throw new Error("The download failed: GitHub answered 403.");
      return "/updates/direct";
    };
    const through = (outcome: "ok" | "no curl" | "unreachable" | "checksum") => async (proxy: string) => {
      tried.push(`through ${proxy}`);
      if (outcome === "unreachable") throw new ProxyDownloadFailed("The download through the proxy at http://127.0.0.1:7890 failed: curl: (7) Failed to connect.");
      if (outcome === "checksum") throw new Error("The download doesn't match the checksum GitHub published for it. Try again.");
      return outcome === "ok" ? "/updates/proxied" : null;
    };
    expect(await preferProxy("http://127.0.0.1:7890", through("ok"), direct("ok"))).toBe("/updates/proxied");
    expect(await preferProxy(null, through("ok"), direct("ok"))).toBe("/updates/direct");
    expect(await preferProxy("http://127.0.0.1:7890", through("no curl"), direct("ok"))).toBe("/updates/direct");
    expect(await preferProxy("http://127.0.0.1:7890", through("unreachable"), direct("ok"))).toBe("/updates/direct");
    tried.length = 0;
    const both = await preferProxy("http://127.0.0.1:7890", through("unreachable"), direct("fails")).catch((error: Error) => error.message);
    expect(both).toBe("The download through the proxy at http://127.0.0.1:7890 failed: curl: (7) Failed to connect. Downloading it directly failed too: The download failed: GitHub answered 403.");
    expect(tried).toEqual(["through http://127.0.0.1:7890", "direct"]);
    tried.length = 0;
    const corrupt = await preferProxy("http://127.0.0.1:7890", through("checksum"), direct("ok")).catch((error: Error) => error.message);
    expect(corrupt).toBe("The download doesn't match the checksum GitHub published for it. Try again.");
    expect(tried).toEqual(["through http://127.0.0.1:7890"]);
  });

  test("the login shell's variables, after whatever its startup files print", () => {
    expect(shellProxy("Welcome back!\n\n\u001epikibun-proxy http://127.0.0.1:7890\n")).toBe("http://127.0.0.1:7890");
    expect(shellProxy("\n\u001epikibun-proxy socks5://127.0.0.1:7891\n")).toBe("socks5://127.0.0.1:7891");
    expect(shellProxy("\n\u001epikibun-proxy 127.0.0.1:7890/\n")).toBe("http://127.0.0.1:7890");
    expect(shellProxy("\n\u001epikibun-proxy \n")).toBe(null);
    expect(shellProxy("zsh: no such file")).toBe(null);
  });

  test("GNOME's manual proxy, HTTPS before HTTP before SOCKS", () => {
    expect(gnomeProxy("\u001epikibun-proxy https '' 0\n\u001epikibun-proxy http '127.0.0.1' 7890\n\u001epikibun-proxy socks '127.0.0.1' 7891\n")).toBe("http://127.0.0.1:7890");
    expect(gnomeProxy("\u001epikibun-proxy https '' 0\n\u001epikibun-proxy http '' 0\n\u001epikibun-proxy socks '::1' 7891\n")).toBe("socks5h://[::1]:7891");
    expect(gnomeProxy("")).toBe(null);
  });

  test("only a proxy cmd and the shells pass on as it is", () => {
    expect(proxyUrl("http://user:secret@proxy.lan:3128")).toBe("http://user:secret@proxy.lan:3128");
    expect(proxyUrl("127.0.0.1:7890 & calc")).toBe(null);
    expect(proxyUrl("http://%USERNAME%@proxy:1")).toBe(null);
    expect(proxyUrl("ftp://proxy:21")).toBe(null);
    expect(proxyUrl("")).toBe(null);
  });

  test("curl follows GitHub's redirect through the proxy into the updates folder", () => {
    const args = curlArguments("https://github.com/OpenCara/pikibun/releases/download/app-v0.17.0/x.dmg", "http://127.0.0.1:7890", "x.dmg.part");
    expect(args.slice(args.indexOf("--proxy"), args.indexOf("--proxy") + 2)).toEqual(["--proxy", "http://127.0.0.1:7890"]);
    expect(args).toContain("--location");
    expect(args).toContain("--fail");
    expect(args.slice(-3)).toEqual(["--output", "x.dmg.part", "https://github.com/OpenCara/pikibun/releases/download/app-v0.17.0/x.dmg"]);
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
  test("a newer release shows on the main page; its button downloads it with progress, installs it and restarts", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "paused" });
    await app.waitFor("id:home-update-button");
    expect(showsText("Pikibun 0.17.0 is available")).toBe(true);
    await app.press("id:home-update-button");
    await app.waitUntil(() => showsText("Downloading Pikibun 0.17.0… 50%"));
    expect(app.shows("id:home-update-progress-bar")).toBe(true);
    expect(showsText("10.9 MB of 21.9 MB")).toBe(true);
    expect(app.shows("id:home-update-button")).toBe(false);
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

  test("an update started right after launch waits for the last one's leftovers to be cleared first", async () => {
    const { app, sent } = await openUpdater({ cleanUp: "slow" });
    await app.waitFor("id:home-update-button");
    await app.press("id:home-update-button");
    await app.waitUntil(() => sent().includes("restart"));
    const order = sent();
    expect(order.indexOf("cleaned up")).toBeLessThan(order.findIndex(line => line.startsWith("download ")));
  });

  test("a failed update says why, and can be tried again", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "install-fails" });
    await app.waitFor("id:app-update-button");
    await app.press("id:app-update-button");
    await app.waitFor("id:app-update-failed");
    expect(showsText("/Applications can't be written by ada")).toBe(true);
    expect(app.shows("id:home-update-failed")).toBe(true);
    expect(sent()).not.toContain("restart");
    await app.press("id:app-update-retry");
    await app.waitUntil(() => sent().filter(line => line.startsWith("install ")).length === 2);
    await app.waitFor("id:home-update-retry");
    await app.press("id:home-update-retry");
    await app.waitUntil(() => sent().filter(line => line.startsWith("install ")).length === 3);
  });

  test("Later puts the offer off on the main page, and Settings still has it", async () => {
    const { app } = await openUpdater();
    await app.waitFor("id:home-update-later");
    await app.press("id:home-update-later");
    await app.waitUntil(() => !app.shows("id:home-update"));
    expect(app.shows("id:app-update-button")).toBe(true);
  });

  test("a download that doesn't match GitHub's checksum installs nothing", async () => {
    const { app, sent, showsText } = await openUpdater({ outcome: "download-fails" });
    await app.waitFor("id:home-update-button");
    await app.press("id:home-update-button");
    await app.waitFor("id:app-update-failed");
    expect(showsText("doesn't match the checksum")).toBe(true);
    expect(sent().some(line => line.startsWith("install "))).toBe(false);
  });

  test("up to date, it says so, and checks again on demand", async () => {
    const { app, showsText } = await openUpdater({ current: "0.17.0" });
    await app.waitUntil(() => showsText("Pikibun is up to date"));
    expect(app.shows("id:home-update")).toBe(false);
    expect(showsText("Pikibun 0.17.0")).toBe(true);
    await app.press("id:app-update-check-button");
    await app.waitUntil(() => showsText("Pikibun is up to date"));
  });

  test("a release without this computer's package points to its page", async () => {
    const { app } = await openUpdater({ arch: "x86_64" });
    await app.waitFor("id:app-update-page");
    expect(app.shows("id:app-update-button")).toBe(false);
    expect(app.shows("id:home-update-page")).toBe(true);
    expect(app.shows("id:home-update-button")).toBe(false);
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
    expect(mac.shows("id:home-update")).toBe(false);
  });
});
