#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixWebSite } from "./nsh-web-fixes.mjs";

export const NSH_VERSION = "v0.6.1";
export const NSH_COMMIT = "2f51d8611677c8a6bbad937b39756e8d0cc45350";
export const NSH_ASSET_SHA256 = Object.freeze({
  "nsh-linux-x86_64.tar.gz": "9a7ac692f1c229df476be8ff83a3c5912d271453b644e313f02cb19d18696070",
  "nsh-macos-arm64.tar.gz": "ee1aed2a4d111fe90e6cceca4b9d5f834c9e11cfda525f8be984261a329c06de",
  "nsh-windows-x86_64.zip": "7952c84b165e13515bd2ad2787ef22622e49ce88cb8d877825e40b40f3aff4be",
  "nsh-web.tar.gz": "e509e35fbad261a4a5e27a9225c364ff0d9ddd202a638b02bbfd13fb5cd1b9f1",
  "nsh-android.tar.gz": "aff949eaa53ec7a6d6b717dfa2c60cefc810e598913d33d2421976b8a474c21e",
  "nsh-ios-macos-arm64.tar.gz": "168f7e71167556c5fa1ffd56bdf49db22add6d32cbba5b061ee8324d0cd8d88a",
  "nsh-tui-linux-x86_64.tar.gz": "8bde6cf9c63a6ee7ce8f6f1bba5432bc556659bd747ad615c4beeffdf9a8877c",
  "nsh-tui-linux-arm64.tar.gz": "b3f085c06b6f9fddef3adfeccf655500c35fac9c46a0390b34547506a8e8effc",
  "nsh-tui-macos-arm64.tar.gz": "729a132b6ac72d7b69be24b02e3739b77454948df43e0961c4b07a399311b5e4",
  "nsh-tui-macos-x86_64.tar.gz": "c8a1a703a80a8a1e0a2a794c42a9ebbff2b1f8ae4d4beed9834560a9de747d7d",
  "nsh-tui-windows-x86_64.tar.gz": "c0fd1ce2246561f5c5c4a22922ec2961188224bb77786008f0d841ed8db90411",
  "nsh-tui-windows-arm64.tar.gz": "f3a4b5058bf8b436ba4f87298031b1cd874c4e0b3508a4a471fcf45be6a2f1b4",
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
