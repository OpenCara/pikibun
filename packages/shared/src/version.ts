declare const __PIKIBUN_VERSION__: string | undefined;

export const buildVersion: string | undefined = typeof __PIKIBUN_VERSION__ === "string" ? __PIKIBUN_VERSION__ : undefined;

export const CONNECTOR_VERSION_HEADER = "x-pikibun-version";

export function validVersion(value: string | undefined | null): string | undefined {
  return value && /^[0-9A-Za-z][0-9A-Za-z .+_-]{0,63}$/.test(value) ? value : undefined;
}

export const MINIMUM_CONNECTOR_VERSION = "0.24.0";

export const FIRST_REPORTING_CONNECTOR_VERSION = "0.24.0";

export const DEVELOPMENT_CONNECTOR_VERSION = "dev";

const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function olderRelease(version: string, than: string): boolean {
  const reported = RELEASE.exec(version);
  const required = RELEASE.exec(than);
  if (!reported || !required) return false;
  for (const part of [1, 2, 3]) {
    const difference = Number(reported[part]) - Number(required[part]);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

export function connectorTooOld(version: string | undefined | null, minimum = MINIMUM_CONNECTOR_VERSION): boolean {
  if (version === undefined || version === null || version === "") return olderRelease(FIRST_REPORTING_CONNECTOR_VERSION, minimum);
  return olderRelease(version, minimum);
}
