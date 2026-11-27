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

export const fitInputSchemaLimits = Object.freeze({ bytes: 1024 * 1024, nodes: 20_000, refs: 32, texts: [inputSchemaLimits.text, 512, 128], shallowest: 2 });

const annotationKeys = new Set(["title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "$comment", "$schema", "$id", "$defs", "definitions"]);

const CLASS_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\[dDwWsSbB]/;

function portablePattern(pattern: string): boolean {
  if (CLASS_ESCAPE.test(pattern)) return false;
  try { new RegExp(pattern, "u"); return true; } catch { return false; }
}

interface Fitting { root: Record<string, unknown>; collapseAt: number; text: number; nodes: number; properties: number; refs: Set<string> }

class Unfit extends Error {
  constructor(readonly reason: "bytes" | "size" | "never") { super(reason); }
}

function pointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let part: string;
    try { part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return undefined; }
    if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(part)) node = node[Number(part)];
    else if (isObject(node) && Object.hasOwn(node, part)) node = node[part];
    else return undefined;
  }
  return node;
}

function fitType(value: unknown): unknown {
  const types = Array.isArray(value) ? value : [value];
  if (!types.length || types.some(item => typeof item !== "string" || !typeNames.has(item))) return undefined;
  return Array.isArray(value) ? [...new Set(types)] : value;
}

function fitText(value: Record<string, unknown>, result: Record<string, unknown>, fitting: Fitting): void {
  for (const key of textKeys) if (typeof value[key] === "string") result[key] = (value[key] as string).slice(0, key === "format" ? inputSchemaLimits.text : fitting.text);
}

function opaque(value: Record<string, unknown>, fitting: Fitting): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const type = fitType(value.type);
  if (type !== undefined) result.type = type;
  fitText(value, result, fitting);
  return result;
}

const structureKeys = ["properties", "items", "additionalProperties", ...branchKeys] as const;

function fitNode(value: unknown, depth: number, fitting: Fitting): Record<string, unknown> {
  if (++fitting.nodes > fitInputSchemaLimits.nodes) throw new Unfit("size");
  if (!isObject(value)) return {};
  if (typeof value.$ref === "string") {
    const { $ref, ...rest } = value;
    const target = fitting.refs.has($ref) || fitting.refs.size >= fitInputSchemaLimits.refs ? undefined : pointer(fitting.root, $ref);
    if (!isObject(target)) return fitNode(rest, depth, fitting);
    fitting.refs.add($ref);
    try {
      const merged = Object.keys(rest).every(key => annotationKeys.has(key)) ? { ...target, ...rest } : { ...rest, allOf: [target, ...(Array.isArray(rest.allOf) ? rest.allOf : [])] };
      return fitNode(merged, depth, fitting);
    } finally { fitting.refs.delete($ref); }
  }
  if (depth >= fitting.collapseAt && structureKeys.some(key => isObject(value[key]) || Array.isArray(value[key]))) return opaque(value, fitting);
  const result: Record<string, unknown> = {};
  let type = fitType(value.type);
  if (type !== undefined && value.nullable === true) type = [...new Set([...(Array.isArray(type) ? type : [type]), "null"])];
  if (type !== undefined) result.type = type;
  fitText(value, result, fitting);
  for (const key of numberKeys) if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  for (const key of countKeys) if (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) result[key] = value[key];
  if (typeof value.uniqueItems === "boolean") result.uniqueItems = value.uniqueItems;
  if (typeof value.pattern === "string" && value.pattern.length <= inputSchemaLimits.pattern && portablePattern(value.pattern)) result.pattern = value.pattern;
  if (Array.isArray(value.enum) && value.enum.length && value.enum.length <= inputSchemaLimits.enum && value.enum.every(scalar)) result.enum = [...value.enum];
  if (value.const !== undefined && scalar(value.const)) result.const = value.const;
  if (value.default !== undefined && plainJson(value.default, depth)) result.default = value.default;
  if (isObject(value.properties)) {
    if (Object.keys(value.properties).some(name => name.length > 128)) {
      if (depth === 1) throw new Unfit("never");
      return opaque(value, fitting);
    }
    if (depth === 1 && Object.keys(value.properties).length > inputSchemaLimits.properties) throw new Unfit("never");
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value.properties)) {
      if (++fitting.properties > inputSchemaLimits.properties) throw new Unfit("size");
      properties[name] = fitNode(child, depth + 1, fitting);
    }
    result.properties = properties;
  }
  if (Array.isArray(value.required) && value.required.length <= inputSchemaLimits.properties
    && value.required.every(item => typeof item === "string" && item.length <= 128)) result.required = [...new Set(value.required as string[])];
  if (typeof value.additionalProperties === "boolean") {
    if (value.additionalProperties || value.patternProperties === undefined) result.additionalProperties = value.additionalProperties;
  } else if (isObject(value.additionalProperties) && value.patternProperties === undefined) {
    result.additionalProperties = fitNode(value.additionalProperties, depth + 1, fitting);
  }
  if (value.prefixItems === undefined) {
    if (typeof value.items === "boolean") result.items = value.items;
    else if (isObject(value.items)) result.items = fitNode(value.items, depth + 1, fitting);
  }
  const branches = (key: string): unknown[] | undefined => {
    const list = value[key];
    return Array.isArray(list) && list.length && list.length <= 16 ? list : undefined;
  };
  const anyOf = branches("anyOf") ?? (value.anyOf === undefined ? branches("oneOf") : undefined);
  const allOf = branches("allOf");
  if (anyOf) result.anyOf = anyOf.map(branch => fitNode(branch, depth + 1, fitting));
  if (allOf) result.allOf = allOf.map(branch => fitNode(branch, depth + 1, fitting));
  return result;
}

export function fitInputSchema(value: unknown): InputSchema | undefined {
  if (!isObject(value)) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return undefined; }
  if (serialized.length > fitInputSchemaLimits.bytes) return undefined;
  let collapseAt = inputSchemaLimits.depth;
  let texts = 0;
  for (;;) {
    const fitting: Fitting = { root: value, collapseAt, text: fitInputSchemaLimits.texts[texts]!, nodes: 0, properties: 0, refs: new Set() };
    let reason: Unfit["reason"] = "bytes";
    try {
      const fitted = fitNode(value, 1, fitting);
      const types = fitted.type === undefined ? ["object"] : Array.isArray(fitted.type) ? fitted.type : [fitted.type];
      if (!types.includes("object")) return undefined;
      const schema = sanitizeInputSchema({ ...fitted, type: "object" });
      if (schema) return schema;
    } catch (error) {
      if (!(error instanceof Unfit)) throw error;
      reason = error.reason;
    }
    if (reason === "never") return undefined;
    if (reason === "bytes" && texts < fitInputSchemaLimits.texts.length - 1) texts++;
    else if (collapseAt > fitInputSchemaLimits.shallowest) collapseAt--;
    else return undefined;
  }
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
