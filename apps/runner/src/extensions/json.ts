import type { JsonValue } from "@earendil-works/chord/json";

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(item => isJsonValue(item, depth + 1));
}
