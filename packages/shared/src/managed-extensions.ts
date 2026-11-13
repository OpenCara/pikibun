import { EXACT_VERSION, PACKAGE_NAME, PIKI_NAME } from "./host-extensions.js";
import { connectorTooOld } from "./version.js";

export interface ManagedExtensionPin {
  source: string;
  package: string;
  version: string;
  integrity: string;
  minimumConnector: string;
}

export const MANAGED_EXTENSION_SCOPE = "@pikibun/";

export const MANAGED_EXTENSIONS_LIMIT = 32;

export const managedExtensions: readonly ManagedExtensionPin[] = Object.freeze([]);

const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEYS = ["integrity", "minimumConnector", "package", "source", "version"].join();

export function parseManagedExtensionPin(value: unknown): ManagedExtensionPin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pin = value as Record<string, unknown>;
  if (Object.keys(pin).sort().join() !== KEYS) return undefined;
  const { source, package: name, version, integrity, minimumConnector } = pin;
  if (typeof source !== "string" || !source.startsWith("piki:") || !PIKI_NAME.test(source.slice(5))) return undefined;
  if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name)) return undefined;
  if (typeof version !== "string" || version.length > 64 || !EXACT_VERSION.test(version)) return undefined;
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) return undefined;
  if (typeof minimumConnector !== "string" || minimumConnector.length > 64 || !RELEASE.test(minimumConnector)) return undefined;
  return { source, package: name, version, integrity, minimumConnector };
}

export function parseManagedExtensions(value: unknown): ManagedExtensionPin[] {
  if (!Array.isArray(value)) return [];
  const pins: ManagedExtensionPin[] = [];
  for (const item of value.slice(0, MANAGED_EXTENSIONS_LIMIT)) {
    const pin = parseManagedExtensionPin(item);
    if (pin && !pins.some(other => other.source === pin.source)) pins.push(pin);
  }
  return pins;
}

export function managedPinKey(pin: ManagedExtensionPin): string {
  return `${pin.source} ${pin.package}@${pin.version} ${pin.integrity}`;
}

export function inManagedScope(name: string): boolean {
  return name.startsWith(MANAGED_EXTENSION_SCOPE) && PACKAGE_NAME.test(name);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (const part of [1, 2, 3]) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const ours = left[4].split(".");
  const theirs = right[4].split(".");
  for (let index = 0; index < Math.max(ours.length, theirs.length); index++) {
    const x = ours[index];
    const y = theirs[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function connectorRelease(version: string | undefined): version is string {
  return typeof version === "string" && RELEASE.test(version);
}

export function connectorRunsPin(pin: ManagedExtensionPin, connectorVersion: string | undefined): boolean {
  return connectorRelease(connectorVersion) && !connectorTooOld(connectorVersion, pin.minimumConnector);
}
