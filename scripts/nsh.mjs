#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixWebSite } from "./nsh-web-fixes.mjs";

export const NSH_VERSION = "v0.7.0";
export const NSH_COMMIT = "3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359";
export const NSH_ASSET_SHA256 = Object.freeze({
  "nsh-linux-x86_64.tar.gz": "d281bfa3d93d84e9831e1a97dfdb63104329fcc87a0a48c78db5aeabb00c0073",
  "nsh-macos-arm64.tar.gz": "5b2e5385e09a65ed63b178a8dd9cef03a9dcab204d2efc942300e0c5baea3853",
  "nsh-windows-x86_64.zip": "1c6ef86afe754198209fd452625f20f32077ecfca3a4431f960a411b0e51d8f3",
  "nsh-web.tar.gz": "e951e78966a65af4d7a0bbcd08a4a5eef4f3b6b4adaec3b4b502df7c4fe8b4e6",
  "nsh-android.tar.gz": "8503e4d4ee853dfeadf0e5dc984811767da8bc2e9309031870b9309375b754fb",
  "nsh-ios-macos-arm64.tar.gz": "4d3a45bd7c4a85f464cd05de775ae3d5d01dcc3a8abdf167f93ba94fd230cb97",
  "nsh-tui-linux-x86_64.tar.gz": "f453fedfa7a93b22bf75e6c429ff6edfa158fda25d3896e0240171806a06a1e2",
  "nsh-tui-linux-arm64.tar.gz": "b8615e3a3399c89e1b5d8d13447b374bc7b320add67687ca385c58b2e7bd97e9",
  "nsh-tui-macos-arm64.tar.gz": "687201dbe46de47c4688775d8282df0582dba0412f6db268caa3988de1e4f524",
  "nsh-tui-macos-x86_64.tar.gz": "0283f22e633d1643677c327e0ea3e07e0af677f0500c6b81507fb366a0be9613",
  "nsh-tui-windows-x86_64.tar.gz": "03d3782d2409124ba93a1f092f182d111fde2a1a9a70724e5bedaf9c8f9e3b07",
  "nsh-tui-windows-arm64.tar.gz": "4f470caa5692247836cfd09f0480d163bb97b30daa5163b479a179595b7db2ae",
});

export const NSH_TUI_HOSTS = Object.freeze({
  "linux-x64": "nsh-tui-linux-x86_64.tar.gz",
  "linux-arm64": "nsh-tui-linux-arm64.tar.gz",
  "darwin-arm64": "nsh-tui-macos-arm64.tar.gz",
  "darwin-x64": "nsh-tui-macos-x86_64.tar.gz",
  "win32-x64": "nsh-tui-windows-x86_64.tar.gz",
  "win32-arm64": "nsh-tui-windows-arm64.tar.gz",
});

export const NSH_COMPONENTS = Object.freeze({
  web: { asset: "nsh-web.tar.gz", paths: ["runtime/web"] },
  android: {
    asset: "nsh-android.tar.gz",
    paths: ["runtime/android/release/classes.dex", "runtime/android/release/lib", "runtime/android/dev/classes.dex", "runtime/android/dev/lib"],
  },
  ios: { asset: "nsh-ios-macos-arm64.tar.gz", paths: ["runtime/ios"], host: "darwin-arm64" },
  tui: { assets: NSH_TUI_HOSTS, paths: ["runtime/tui"] },
});
const TARGET_COMPONENTS = { web: "web", android: "android", ios: "ios", catalyst: "ios", tui: "tui" };

export function componentAsset(component, host = `${platform()}-${arch()}`) {
  return component.asset ?? component.assets?.[host] ?? null;
}

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

export async function unpackPinned(asset, partial, what) {
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

export async function nshComponent(name, { required = false } = {}) {
  const component = NSH_COMPONENTS[name];
  if (!component) throw new Error(`No Native Shell component ${name} is pinned (${Object.keys(NSH_COMPONENTS).join(", ")}).`);
  const skipped = process.env.NSH_BIN ? "NSH_BIN names another nsh, which adds its own components"
    : !release() ? `no Native Shell CLI is pinned for ${platform()}-${arch()}`
    : component.host && component.host !== `${platform()}-${arch()}` ? `it is published for ${component.host} only`
    : !componentAsset(component) ? `it is published for ${Object.keys(component.assets).join(", ")} only`
    : "";
  if (skipped) {
    if (required) throw new Error(`The pinned ${name} component can't be added here: ${skipped}.`);
    return;
  }
  const root = distribution();
  const record = path.join("components", `${name}.json`);
  if ([record, ...component.paths].every(item => existsSync(path.join(root, item)))) return;
  const partial = path.join(root, `.component-${name}.partial`);
  try {
    const asset = componentAsset(component);
    await unpackPinned(asset, partial, `its ${name} runtime`);
    for (const item of [...component.paths, record]) {
      const from = path.join(partial, "nsh", item);
      if (!existsSync(from)) throw new Error(`${asset} holds no nsh/${item.split(path.sep).join("/")}`);
      const to = path.join(root, item);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
    }
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

export function targetComponent(args) {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const at = own.findIndex(argument => argument === "--target" || argument.startsWith("--target="));
  if (at < 0) return null;
  const target = own[at].startsWith("--target=") ? own[at].slice("--target=".length) : own[at + 1];
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
      for (const name of rest) await nshComponent(name, { required: true });
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
