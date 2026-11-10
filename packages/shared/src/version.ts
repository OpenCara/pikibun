declare const __PIKIBUN_VERSION__: string | undefined;

/**
 * The release this build is, as its build script stamps it: the `pikibun` package's version in the CLI's bundle
 * (packages/cli/scripts/build.mjs), which runs the connector and the local server (the former Electron app's stamped
 * `desktop <version>`). Undefined in development and tests, which run the sources unbundled.
 * The server image is told its version by PIKIBUN_VERSION instead (the Dockerfile), since it builds with plain esbuild.
 */
export const buildVersion: string | undefined = typeof __PIKIBUN_VERSION__ === "string" ? __PIKIBUN_VERSION__ : undefined;

/** The header a connector names its version in, on its callbacks; older servers ignore it, so older connectors need none. */
export const CONNECTOR_VERSION_HEADER = "x-pikibun-version";

/** A version a connector or the server reports, as shown: `0.23.1`, `0.24.0-beta.1`, `desktop 0.8.1`. */
export function validVersion(value: string | undefined | null): string | undefined {
  return value && /^[0-9A-Za-z][0-9A-Za-z .+_-]{0,63}$/.test(value) ? value : undefined;
}

export const MINIMUM_CONNECTOR_VERSION = "0.24.0";

const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function connectorTooOld(version: string | undefined | null, minimum = MINIMUM_CONNECTOR_VERSION): boolean {
  const reported = RELEASE.exec(version ?? "");
  const required = RELEASE.exec(minimum);
  if (!reported || !required) return false;
  for (const part of [1, 2, 3]) {
    const difference = Number(reported[part]) - Number(required[part]);
    if (difference !== 0) return difference < 0;
  }
  return false;
}
