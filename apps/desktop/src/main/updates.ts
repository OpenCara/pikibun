// New desktop releases on GitHub: the app checks the repository's releases now and then and, when a `desktop-v1.2.3`
// release newer than itself is out, offers it (the menus, the tray, and the web app's sidebar through
// remote-bridge.ts). Updating opens the release page, whose DMG the owner installs as the first one: nothing downloads
// or runs by itself. The page's address is built here from the tag, never taken from the response. Pure but for the
// fetch it is given, so tests run it without Electron.

export const RELEASES_API = "https://api.github.com/repos/OpenCara/pikibun/releases?per_page=50";
const RELEASE_PAGE = "https://github.com/OpenCara/pikibun/releases/tag/";
const TAG = /^desktop-v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/;
const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/;

export interface AvailableUpdate {
  /** The release's version, such as 1.2.3. */
  version: string;
  /** Its GitHub release page. */
  url: string;
}

/** Semantic version precedence: -1, 0 or 1; undefined when either isn't a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  // A prerelease comes before its release; prereleases compare identifier by identifier.
  const [leftPre, rightPre] = [left[4], right[4]];
  if (!leftPre || !rightPre) return leftPre ? -1 : rightPre ? 1 : 0;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const [x, y] = [leftIds[index], rightIds[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^[0-9]+$/.test(x), /^[0-9]+$/.test(y)];
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest published desktop release in GitHub's release list, if it is newer than `current`. Other release lines
 * (server-v, cli-v) and drafts never count; prereleases count only while the app itself runs one.
 */
export function newerRelease(releases: unknown, current: string): AvailableUpdate | undefined {
  if (!Array.isArray(releases) || compareVersions(current, current) === undefined) return undefined;
  const prereleases = current.includes("-");
  let best: string | undefined;
  for (const release of releases) {
    if (!release || typeof release !== "object") continue;
    const { tag_name: tag, draft, prerelease } = release as Record<string, unknown>;
    const version = typeof tag === "string" ? TAG.exec(tag)?.[1] : undefined;
    if (!version || draft !== false || (prerelease !== false && !prereleases)) continue;
    if (!best || compareVersions(version, best) === 1) best = version;
  }
  if (!best || compareVersions(best, current) !== 1) return undefined;
  return { version: best, url: `${RELEASE_PAGE}desktop-v${best}` };
}

export interface UpdateCheckerOptions {
  /** The app's own version. */
  current: string;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  onChange(update: AvailableUpdate | undefined): void;
}

/** Checks GitHub for a newer desktop release; a failed check keeps what the last one found. */
export class UpdateChecker {
  private found: AvailableUpdate | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: UpdateCheckerOptions) {}

  get available(): AvailableUpdate | undefined { return this.found; }

  /** Whether the check reached GitHub; `available` holds its answer. */
  async check(): Promise<boolean> {
    let releases: unknown;
    try {
      const response = await this.options.fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      if (!response.ok) return false;
      releases = await response.json();
    } catch {
      return false;
    }
    if (!Array.isArray(releases)) return false;
    const next = newerRelease(releases, this.options.current);
    if (next?.version !== this.found?.version) {
      this.found = next;
      this.options.onChange(next);
    }
    return true;
  }

  /** A first check soon after launch, then one every `interval` (GitHub allows 60 unauthenticated calls an hour). */
  start(delay = 10_000, interval = 6 * 60 * 60 * 1000): void {
    if (this.timer) return;
    const first = setTimeout(() => void this.check(), delay);
    first.unref?.();
    this.timer = setInterval(() => void this.check(), interval);
    this.timer.unref?.();
  }
}
