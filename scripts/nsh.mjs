#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixWebSite } from "./nsh-web-fixes.mjs";

export const NSH_VERSION = "v0.5.0";
export const NSH_COMMIT = "f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1";
export const NSH_ASSET_SHA256 = Object.freeze({
  "nsh-linux-x86_64.tar.gz": "a422bbe5dc2a7ae3ff308ee56e05d73d5becc81f57adf11447fc570dcee65e0f",
  "nsh-macos-arm64.tar.gz": "e6722427b391b00cf7ec13137db9366e78d1e7a045f2933cf00b340365309d9d",
  "nsh-windows-x86_64.zip": "63bacd122a5e41818513d232b2de82a5b3362b1199abcf0e9692fcb82ee74622",
  "nsh-web.tar.gz": "17c4d8b690c1291ffeec59c6dcc6cb967bd03dbb4864ac9a61d3cd3d2192c477",
  "nsh-android.tar.gz": "bd9f42c043c08f0c29c874d2a8247e389258f88778a5160d646f73fc2ccfbe73",
  "nsh-ios-macos-arm64.tar.gz": "e0a5039702ad3c53fa938d8dfba488856e8be8632f5fac1538f241df6f6bb53d",
});

// Since 0.5 a platform's archive holds the CLI and that platform's own runtime; the others are components, archives of
// the same release that `nsh` adds on demand (`nsh component add`), checked only against the release's own `.sha256`.
// So the pinned ones are added here first, checked against the digests above. Each archive holds `nsh/<paths>` and
// its record, `nsh/components/<name>.json`, which `nsh` reads to tell it is installed.
export const NSH_COMPONENTS = Object.freeze({
  web: { asset: "nsh-web.tar.gz", paths: ["runtime/web"] },
  android: {
    asset: "nsh-android.tar.gz",
    paths: ["runtime/android/release/classes.dex", "runtime/android/release/lib", "runtime/android/dev/classes.dex", "runtime/android/dev/lib"],
  },
  ios: { asset: "nsh-ios-macos-arm64.tar.gz", paths: ["runtime/ios"], host: "darwin-arm64" },
});
const TARGET_COMPONENTS = { web: "web", android: "android", ios: "ios", catalyst: "ios" };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(repository, "apps", "nsh");

function release() {
  if (platform() === "linux" && arch() === "x64") return "nsh-linux-x86_64.tar.gz";
  if (platform() === "darwin" && arch() === "arm64") return "nsh-macos-arm64.tar.gz";
  if (platform() === "win32" && arch() === "x64") return "nsh-windows-x86_64.zip";
  return null;
}

const apiAssets = new Map();

async function apiAsset(source) {
  if (!apiAssets.has(source.pathname)) {
    const metadata = await fetch(`https://api.github.com/repos/longbridge/nsh/releases/tags/${NSH_VERSION}`, {
      headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
    });
    if (!metadata.ok) throw new Error(`Release metadata: HTTP ${metadata.status}`);
    const release = await metadata.json();
    for (const asset of release.assets || []) {
      if (/^https:\/\/api\.github\.com\/repos\/longbridge\/nsh\/releases\/assets\/[0-9]+$/.test(asset.url)) {
        apiAssets.set(`/longbridge/nsh/releases/download/${NSH_VERSION}/${asset.name}`, asset.url);
      }
    }
  }
  const url = apiAssets.get(source.pathname);
  if (!url) throw new Error(`No API asset for ${source.pathname}`);
  return new URL(url);
}

export async function releaseAsset(url, { attempts = 4, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const source = new URL(url);
      const viaApi = attempt % 2 === 0 && source.origin === 'https://github.com'
        && source.pathname.startsWith(`/longbridge/nsh/releases/download/${NSH_VERSION}/`);
      const request = viaApi ? await apiAsset(source) : source;
      if (attempt > 1) request.searchParams.set('_pikibun_retry', `${Date.now()}-${attempt}`);
      const response = await fetch(request, { headers: { 'Cache-Control': 'no-cache', ...(viaApi ? { Accept: 'application/octet-stream' } : {}) } });
      if (!response.ok) throw new Error(`downloading ${new URL(url).pathname}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === attempts) throw error;
      console.error(`Release download attempt ${attempt}/${attempts} failed: ${error.message}; retrying`);
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

function pinnedDigest(asset) {
  const expected = NSH_ASSET_SHA256[asset];
  if (!expected) throw new Error(`No SHA-256 is pinned for ${asset} of Native Shell ${NSH_VERSION}: add it to NSH_ASSET_SHA256 in scripts/nsh.mjs.`);
  return expected;
}

export function checkAsset(asset, bytes) {
  const expected = pinnedDigest(asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${asset} does not match the SHA-256 pinned for Native Shell ${NSH_VERSION} (${actual} != ${expected})`);
}

async function unpackPinned(asset, partial, what) {
  pinnedDigest(asset);
  console.error(`Downloading Native Shell ${NSH_VERSION} (${asset}, ${what}, once)…`);
  const bytes = await releaseAsset(`https://github.com/longbridge/nsh/releases/download/${NSH_VERSION}/${asset}`);
  checkAsset(asset, bytes);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const archive = path.join(partial, asset);
  writeFileSync(archive, bytes);
  const untar = spawnSync("tar", [asset.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", partial], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error(`extracting ${asset} failed`);
  rmSync(archive);
}

async function download(asset, directory) {
  const partial = `${directory}.partial`;
  await unpackPinned(asset, partial, "the CLI and this platform's runtime");
  rmSync(directory, { recursive: true, force: true });
  renameSync(partial, directory);
}

const distribution = () => path.join(repository, ".cache", "nsh", NSH_VERSION, "nsh");

/** Adds the pinned component `name` to the downloaded distribution, unless it has it, or NSH comes from elsewhere. */
export async function nshComponent(name) {
  const component = NSH_COMPONENTS[name];
  if (!component) throw new Error(`No Native Shell component ${name} is pinned (${Object.keys(NSH_COMPONENTS).join(", ")}).`);
  if (process.env.NSH_BIN || !release()) return;
  if (component.host && component.host !== `${platform()}-${arch()}`) return;
  const root = distribution();
  const record = path.join("components", `${name}.json`);
  if ([record, ...component.paths].every(item => existsSync(path.join(root, item)))) return;
  const partial = path.join(root, `.component-${name}.partial`);
  try {
    await unpackPinned(component.asset, partial, `its ${name} runtime`);
    // The runtime first and the record last, so a component cut short counts as missing.
    for (const item of [...component.paths, record]) {
      const from = path.join(partial, "nsh", item);
      if (!existsSync(from)) throw new Error(`${component.asset} holds no nsh/${item.split(path.sep).join("/")}`);
      const to = path.join(root, item);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
    }
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

/** The component an `nsh` command's `--target` needs, if any. */
export function targetComponent(args) {
  const at = args.findIndex(argument => argument === "--target" || argument.startsWith("--target="));
  if (at < 0) return null;
  const target = args[at].startsWith("--target=") ? args[at].slice("--target=".length) : args[at + 1];
  return TARGET_COMPONENTS[target] ?? null;
}

export async function nshBinary() {
  if (process.env.NSH_BIN) return process.env.NSH_BIN;
  const asset = release();
  if (asset) {
    const bin = path.join(distribution(), "bin", platform() === "win32" ? "nsh.exe" : "nsh");
    if (!existsSync(bin)) await download(asset, path.dirname(distribution()));
    return bin;
  }
  const found = spawnSync("nsh", ["--version"], { encoding: "utf8" });
  if (found.status === 0) {
    if (!found.stdout.includes(NSH_VERSION.slice(1))) console.error(`warning: ${found.stdout.trim()} on PATH; the client is built with ${NSH_VERSION}.`);
    return "nsh";
  }
  throw new Error(`Install Native Shell ${NSH_VERSION} (https://nsh.dev/docs/installation) or set NSH_BIN.`);
}

function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: app, stdio: "inherit", env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function buildWeb(out = path.join(repository, "dist", "client")) {
  const bin = await nshBinary();
  await nshComponent("web");
  const staging = path.join(repository, "dist", ".nsh-web");
  rmSync(staging, { recursive: true, force: true });
  const status = run(bin, ["package", "App.tsx", "--target", "web", "--out", staging]);
  if (status !== 0) throw new Error(`nsh package exited with ${status}`);
  const [site] = readdirSync(staging);
  if (!site || !existsSync(path.join(staging, site, "index.html"))) throw new Error(`nsh package wrote no site into ${staging}`);
  fixWebSite(path.join(staging, site));
  for (const name of ["sw.js", "favicon.svg"]) cpSync(path.join(app, "web", name), path.join(staging, site, name));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.dirname(out), { recursive: true });
  cpSync(path.join(staging, site), out, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  console.error(`The web app is in ${path.relative(repository, out) || out}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  try {
    if (first === "--build-web") await buildWeb(rest[0] ? path.resolve(rest[0]) : undefined);
    else if (first === "--component") {
      await nshBinary();
      for (const name of rest) await nshComponent(name);
    } else {
      const args = [first, ...rest].filter(argument => argument !== undefined);
      const bin = await nshBinary();
      const component = targetComponent(args);
      if (component) await nshComponent(component);
      process.exitCode = run(bin, args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
