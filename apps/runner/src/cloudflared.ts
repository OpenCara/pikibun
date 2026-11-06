import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

/*
 * The cloudflared the tunnel tool runs (piki:tunnel; docs/design/tunnel.md): the host's own, as its owner installed it,
 * at a path they give, or one the connector downloads from Cloudflare's releases. It runs in the connector, on the host,
 * never in a session's sandbox: it is the one part that must reach Cloudflare's edge (port 7844), which the sandbox's
 * egress proxy never tunnels, and it holds the tunnel, which nothing in the sandbox should. It is found:
 * - PIKIBUN_CLOUDFLARED, the path of a cloudflared executable, set for the connector by the host's owner;
 * - else cloudflared on the connector's PATH, or where packages install it (/usr/local/bin, /usr/bin, Homebrew's);
 * - else the newest one the connector downloaded.
 * Only a real executable is taken (on Linux an ELF, not a wrapper script). Unlike the browser's Chromium, nothing of it
 * is given to sessions: the connector runs it as it is, so it may be anywhere, a home's ~/.local/bin included.
 */

export interface CloudflaredToolchain {
  /** The cloudflared executable on the host, through links. */
  executable: string;
  /** Its version, where the connector knows it: one it downloaded. */
  version?: string;
}

/** Where packages and installers put cloudflared, after the connector's PATH. */
export const SYSTEM_CLOUDFLAREDS: readonly string[] = Object.freeze([
  "/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/home/linuxbrew/.linuxbrew/bin/cloudflared",
]);

/** Cloudflare's releases of cloudflared, on GitHub. */
export const CLOUDFLARED_RELEASES = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
/** Where its downloads are; one from anywhere else is refused. */
const DOWNLOAD_PREFIX = "https://github.com/cloudflare/cloudflared/releases/download/";
/** Where GitHub sends a release's downloads. */
const DOWNLOAD_HOSTS: readonly string[] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const VERSION = /^\d{4}\.\d{1,2}\.\d{1,3}$/;
/** The lone executables Cloudflare builds, by Node's platform and architecture. */
const ASSETS: Readonly<Record<string, string>> = Object.freeze({ "linux x64": "cloudflared-linux-amd64", "linux arm64": "cloudflared-linux-arm64" });

export const cloudflaredLimits = Object.freeze({
  /** The executable, about 40 MB today. */
  bytes: 256 * 1024 * 1024,
  releaseBytes: 2 * 1024 * 1024,
});

/** The release asset this connector would download, or undefined where Cloudflare builds none it takes. */
export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  return ASSETS[`${platform} ${arch}`];
}

/** Whether `path` starts as a Linux executable does, rather than a script that runs one. */
function elf(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The executable `path` names, or why it isn't one: a real executable file, an ELF on Linux. The reasons are for the
 * host's owner, who chose the path.
 */
export function inspectCloudflared(path: string, options: { platform?: NodeJS.Platform } = {}): { cloudflared: CloudflaredToolchain } | { error: string } {
  const platform = options.platform ?? process.platform;
  let executable: string;
  try { executable = realpathSync(path); } catch { return { error: `Nothing is at ${path}` }; }
  try {
    if (!statSync(executable).isFile()) return { error: `${executable} isn't a file` };
    accessSync(executable, constants.X_OK);
  } catch { return { error: `${executable} isn't executable` }; }
  if (platform === "linux" && !elf(executable)) return { error: `${executable} isn't a program but a script or another file: give the cloudflared executable itself` };
  return { cloudflared: { executable } };
}

/** The cloudflared `path` names, or undefined where it isn't one (inspectCloudflared). */
export function cloudflaredAt(path: string, options: { platform?: NodeJS.Platform } = {}): CloudflaredToolchain | undefined {
  const found = inspectCloudflared(path, options);
  return "cloudflared" in found ? found.cloudflared : undefined;
}

/** The host's cloudflared, or undefined where it has none. `env` and `platform`: the connector's, unless a test gives others. */
export function hostCloudflared(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): CloudflaredToolchain | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const at = (path: string) => cloudflaredAt(path, { platform });
  // A path the host's owner chose is that one or none: never another cloudflared than they named.
  if (env.PIKIBUN_CLOUDFLARED) return at(env.PIKIBUN_CLOUDFLARED);
  const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const onPath = (env.PATH ?? "").split(delimiter).filter(entry => entry.startsWith("/") || /^[A-Za-z]:\\/.test(entry)).map(entry => join(entry, name));
  for (const path of [...onPath, ...SYSTEM_CLOUDFLAREDS]) {
    const found = at(path);
    if (found) return found;
  }
  return undefined;
}

/** A cloudflared release: its version, and the one asset this host downloads with its SHA-256, as the release lists it. */
export interface CloudflaredRelease { version: string; asset: string; url: string; sha256: string }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** `url`, or an error that names the host it couldn't reach and why, for the host's owner (a firewall, a proxy). */
async function reach(fetcher: typeof fetch, url: string, signal: AbortSignal | undefined, what: string): Promise<Response> {
  try { return await fetcher(url, { headers: { accept: "application/vnd.github+json, application/octet-stream" }, ...(signal ? { signal } : {}) }); }
  catch (error) {
    if (signal?.aborted) throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code ?? error.cause.message : undefined;
    throw new Error(`Couldn't reach ${new URL(url).host} for ${what}${typeof cause === "string" && cause ? ` (${cause.slice(0, 200)})` : ""}`);
  }
}

/**
 * The latest cloudflared release for `asset`: its version, its download (only at Cloudflare's releases on GitHub) and
 * the SHA-256 its release notes list for it. A release that lists none is refused: the download is checked against it.
 */
export async function latestCloudflared(asset: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<CloudflaredRelease> {
  const response = await reach(options.fetch ?? fetch, CLOUDFLARED_RELEASES, options.signal, "cloudflared's releases");
  if (!response.ok) throw new Error(`cloudflared's releases answered ${response.status}`);
  const text = await response.text();
  if (text.length > cloudflaredLimits.releaseBytes) throw new Error("cloudflared's release is too long");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("cloudflared's release isn't JSON"); }
  const version = isObject(value) ? value.tag_name : undefined;
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("cloudflared's latest release has no version");
  const url = `${DOWNLOAD_PREFIX}${version}/${asset}`;
  const assets = isObject(value) && Array.isArray(value.assets) ? value.assets : [];
  if (!assets.some(item => isObject(item) && item.name === asset && item.browser_download_url === url)) throw new Error(`cloudflared ${version} has no ${asset}`);
  const body = isObject(value) && typeof value.body === "string" ? value.body : "";
  const sha256 = new RegExp(`^\\s*${asset.replace(/[.-]/g, "\\$&")}\\s*:\\s*([0-9a-f]{64})\\s*$`, "m").exec(body)?.[1];
  if (!sha256) throw new Error(`cloudflared ${version}'s release lists no SHA-256 for ${asset}`);
  return { version, asset, url, sha256 };
}

/** The cloudflareds downloaded under `root`, newest first. */
export async function downloadedCloudflareds(root: string): Promise<CloudflaredToolchain[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const newer = (a: string, b: string) => { const x = a.split(".").map(Number); const y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; };
  return names.filter(name => VERSION.test(name)).sort(newer).flatMap(version => {
    const found = cloudflaredAt(join(root, version, "cloudflared"));
    return found ? [{ ...found, version }] : [];
  });
}

/**
 * Downloads `release` to `root`/<version>/cloudflared unless it is there already, and answers it. It is fetched beside
 * that, checked against the release's SHA-256, and moved into place only whole.
 */
export async function downloadCloudflared(root: string, release: CloudflaredRelease, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<CloudflaredToolchain> {
  if (!VERSION.test(release.version) || release.url !== `${DOWNLOAD_PREFIX}${release.version}/${release.asset}` || !/^[0-9a-f]{64}$/.test(release.sha256)) {
    throw new Error("Not a cloudflared release");
  }
  const target = join(root, release.version);
  const existing = cloudflaredAt(join(target, "cloudflared"));
  if (existing) return { ...existing, version: release.version };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const partial = join(root, `.${release.version}.partial`);
  await rm(partial, { recursive: true, force: true });
  try {
    const response = await reach(options.fetch ?? fetch, release.url, options.signal, "cloudflared's download");
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}`);
    // GitHub sends a release's download on to its own storage: only there.
    if (response.url && !DOWNLOAD_HOSTS.includes(new URL(response.url).host)) throw new Error("cloudflared's download went somewhere else than GitHub");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > cloudflaredLimits.bytes) throw new Error("The download is larger than cloudflared");
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > cloudflaredLimits.bytes) throw new Error("The download is larger than cloudflared");
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (createHash("sha256").update(data).digest("hex") !== release.sha256) throw new Error("cloudflared's download doesn't match its release's SHA-256");
    await mkdir(partial, { mode: 0o700 });
    await writeFile(join(partial, "cloudflared"), data, { mode: 0o755 });
    await chmod(join(partial, "cloudflared"), 0o755);
    if (!cloudflaredAt(join(partial, "cloudflared"))) throw new Error("The download isn't a cloudflared this host runs");
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  const found = cloudflaredAt(join(target, "cloudflared"));
  if (!found) throw new Error("The downloaded cloudflared isn't usable");
  return { ...found, version: release.version };
}

/** Removes from `root` every download but those of the versions in `keep`, and anything a stopped one left. */
export async function pruneCloudflareds(root: string, keep: readonly string[]): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!keep.includes(name)) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}
