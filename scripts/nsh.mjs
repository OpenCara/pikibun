#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixWebSite } from "./nsh-web-fixes.mjs";

export const NSH_VERSION = "v0.7.2";
export const NSH_COMMIT = "0c29b5e3351128f489fe53bfb167160801707191";
export const NSH_ASSET_SHA256 = Object.freeze({
  "nsh-linux-x86_64.tar.gz": "cb087e1e6afeb4ce4c2e70d8f803ccffe376b0a73d48605e492ec50fbbd45bec",
  "nsh-macos-arm64.tar.gz": "cac434767b137f0ba98e4bf609bcffa3daaa87f858c0036235a4be4a36986a42",
  "nsh-windows-x86_64.zip": "f22684757c75e744a3ede334ee0f3c395970f81e975349f33295d61734b7d640",
  "nsh-web.tar.gz": "d5b4de432bffa961bd5df8eda3853b791b4c9f07993c22a6a026a206aa455d5d",
  "nsh-android.tar.gz": "d42ba80050fd0d179bab9efc0d7b637411003a781ba29634ff95da4dd2c5cb89",
  "nsh-ios-macos-arm64.tar.gz": "957f4110b39e97eee4c7e127038df811458242385bad074f8e9d9301c8f70577",
  "nsh-tui-linux-x86_64.tar.gz": "5d8a1b58cfee076426cdd553a8a516169e6cbc55f2d62df1da0254a91ab55514",
  "nsh-tui-linux-arm64.tar.gz": "934e2d285ff60e320475ada1c3439b477a50976783e41f2db80ae84507cec64d",
  "nsh-tui-macos-arm64.tar.gz": "e036c9a204fba3dfc65faa5e4d88e2864491d16d3c41108704d9e9a2d896acae",
  "nsh-tui-macos-x86_64.tar.gz": "58e9721b7f438aee87ae9bdeeb6c49dd5dde256ba360b486d8109687b46db293",
  "nsh-tui-windows-x86_64.tar.gz": "200519efd530e7213ccda6544506574fd48e549a096c189a6b87d45327e78972",
  "nsh-tui-windows-arm64.tar.gz": "5efb136fc0d73999bb46ecac1a99ea20f7d201f6860d62d1c205e8e82582a9b0",
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

export const NSH_TARGET_MODULES = Object.freeze({
  ios: Object.freeze({
    "nsh-extra": Object.freeze({ version: NSH_VERSION.slice(1), features: Object.freeze(["push"]), sha256: "9d795100afbb3b9515a2ba98fad9e33e99c5b58b5cb45ca841a83d7bd10983d5" }),
  }),
});

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

export function commandTarget(args) {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const at = own.findIndex(argument => argument === "--target" || argument.startsWith("--target="));
  if (at < 0) return null;
  return (own[at].startsWith("--target=") ? own[at].slice("--target=".length) : own[at + 1]) ?? null;
}

export function targetComponent(args) {
  return TARGET_COMPONENTS[commandTarget(args)] ?? null;
}

export function targetManifest(text, modules) {
  const manifest = JSON.parse(text);
  const taken = Object.keys(modules).filter(name => manifest.dependencies?.[name]);
  if (taken.length) throw new Error(`apps/nsh/nsh.json already lists ${taken.join(", ")}: scripts/nsh.mjs adds it for the targets that need it (NSH_TARGET_MODULES).`);
  manifest.dependencies = { ...manifest.dependencies,
    ...Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, { version: `=${module.version}`, features: [...module.features] }])) };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function targetLock(modules) {
  return `${JSON.stringify({ version: 2, packages: Object.entries(modules).map(([name, module]) => ({
    name, version: module.version, source: "crates.io", checksum: `sha256-${module.sha256}`, dir: `${name}/${module.version}`, module: name,
  })) }, null, 2)}\n`;
}

function sameJson(one, other) {
  try { return JSON.stringify(JSON.parse(one)) === JSON.stringify(JSON.parse(other)); } catch { return false; }
}

async function withTargetModules(target, work) {
  const modules = NSH_TARGET_MODULES[target];
  if (!modules) return work();
  for (const [name, module] of Object.entries(modules)) {
    const crate = await releaseAsset(`https://static.crates.io/crates/${name}/${name}-${module.version}.crate`);
    const actual = createHash("sha256").update(crate).digest("hex");
    if (actual !== module.sha256) throw new Error(`${name} ${module.version} on crates.io does not match the SHA-256 pinned in NSH_TARGET_MODULES (${actual} != ${module.sha256})`);
  }
  const manifest = path.join(app, "nsh.json");
  const lock = path.join(app, "nsh.lock");
  const original = readFileSync(manifest, "utf8");
  const pinned = targetLock(modules);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    writeFileSync(manifest, original);
    rmSync(lock, { force: true });
  };
  const interrupted = () => { restore(); process.exit(130); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    writeFileSync(manifest, targetManifest(original, modules));
    writeFileSync(lock, pinned);
    console.error(`Building for ${target} with ${Object.entries(modules).map(([name, module]) => `${name} ${module.version} (${module.features.join(", ")})`).join(", ")}: this target is built with the Rust toolchain (https://rustup.rs).`);
    const status = work();
    const locked = existsSync(lock) ? readFileSync(lock, "utf8") : "";
    if (status === 0 && !sameJson(locked, pinned)) {
      console.error(`Native Shell locked other modules than scripts/nsh.mjs pins for ${target} (NSH_TARGET_MODULES):\n${locked}`);
      return 1;
    }
    return status;
  } finally {
    restore();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
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
      process.exitCode = await withTargetModules(commandTarget(args), () => run(bin, args));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
