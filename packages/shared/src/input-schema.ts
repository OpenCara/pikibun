export type InputSchema = Readonly<Record<string, unknown>>;

export const inputSchemaLimits = Object.freeze({ bytes: 32 * 1024, depth: 6, properties: 64, pattern: 256, text: 2048, enum: 64 });

const typeNames = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const textKeys = ["title", "description", "format"] as const;
const numberKeys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const;
const countKeys = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const;
const branchKeys = ["anyOf", "oneOf", "allOf"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function scalar(value: unknown): boolean {
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= inputSchemaLimits.text);
}

function plainJson(value: unknown, depth: number): boolean {
  if (depth > inputSchemaLimits.depth) return false;
  if (scalar(value)) return true;
  if (Array.isArray(value)) return value.length <= inputSchemaLimits.enum && value.every(item => plainJson(item, depth + 1));
  if (isObject(value)) return Object.keys(value).length <= inputSchemaLimits.properties && Object.values(value).every(item => plainJson(item, depth + 1));
  return false;
}

function sanitize(value: unknown, depth: number, counted: { properties: number }): Record<string, unknown> | undefined {
  if (!isObject(value) || depth > inputSchemaLimits.depth) return undefined;
  if ("$ref" in value || "$defs" in value || "definitions" in value || "patternProperties" in value || "$dynamicRef" in value) return undefined;
  const result: Record<string, unknown> = {};
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.some(item => typeof item !== "string" || !typeNames.has(item))) return undefined;
    result.type = Array.isArray(value.type) ? [...types] : value.type;
  }
  for (const key of textKeys) if (typeof value[key] === "string") result[key] = (value[key] as string).slice(0, inputSchemaLimits.text);
  for (const key of numberKeys) if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  for (const key of countKeys) if (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) result[key] = value[key];
  if (typeof value.uniqueItems === "boolean") result.uniqueItems = value.uniqueItems;
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string" || value.pattern.length > inputSchemaLimits.pattern) return undefined;
    try { new RegExp(value.pattern, "u"); } catch { return undefined; }
    result.pattern = value.pattern;
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > inputSchemaLimits.enum || !value.enum.every(scalar)) return undefined;
    result.enum = [...value.enum];
  }
  if (value.const !== undefined) {
    if (!scalar(value.const)) return undefined;
    result.const = value.const;
  }
  if (value.default !== undefined && plainJson(value.default, depth)) result.default = value.default;
  if (value.properties !== undefined) {
    if (!isObject(value.properties)) return undefined;
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value.properties)) {
      if (++counted.properties > inputSchemaLimits.properties || name.length > 128) return undefined;
      const sanitized = sanitize(child, depth + 1, counted);
      if (!sanitized) return undefined;
      properties[name] = sanitized;
    }
    result.properties = properties;
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.length > inputSchemaLimits.properties
      || value.required.some(item => typeof item !== "string" || item.length > 128)) return undefined;
    result.required = [...new Set(value.required as string[])];
  }
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties === "boolean") result.additionalProperties = value.additionalProperties;
    else {
      const sanitized = sanitize(value.additionalProperties, depth + 1, counted);
      if (!sanitized) return undefined;
      result.additionalProperties = sanitized;
    }
  }
  if (value.items !== undefined) {
    if (typeof value.items === "boolean") result.items = value.items;
    else {
      const sanitized = sanitize(value.items, depth + 1, counted);
      if (!sanitized) return undefined;
      result.items = sanitized;
    }
  }
  for (const key of branchKeys) {
    if (value[key] === undefined) continue;
    const branches = value[key];
    if (!Array.isArray(branches) || !branches.length || branches.length > 16) return undefined;
    const sanitized = branches.map(branch => sanitize(branch, depth + 1, counted));
    if (sanitized.some(branch => !branch)) return undefined;
    result[key] = sanitized;
  }
  return result;
}

export function sanitizeInputSchema(value: unknown): InputSchema | undefined {
  if (!isObject(value) || (value.type !== undefined && value.type !== "object")) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return undefined; }
  if (serialized.length > inputSchemaLimits.bytes * 4) return undefined;
  const sanitized = sanitize(value, 1, { properties: 0 });
  if (!sanitized) return undefined;
  const schema = { ...sanitized, type: "object" };
  if (JSON.stringify(schema).length > inputSchemaLimits.bytes) return undefined;
  return Object.freeze(schema);
}
