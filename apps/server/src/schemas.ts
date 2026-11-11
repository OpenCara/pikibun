import { z } from 'zod';
import { fail, jsonObject, PASSWORD_USER_ID } from './http.js';
import type { AppContext } from './types.js';

export interface BodyOptions {
  maxBytes?: number;
  message?: string;
}

export async function body<S extends z.ZodType>(c: AppContext, schema: S, options: BodyOptions = {}): Promise<z.output<S>> {
  const parsed = schema.safeParse(await jsonObject(c, options.maxBytes));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const code = issue?.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : undefined;
  return fail(400, typeof code === 'string' ? code : 'invalid_input', options.message ?? issue?.message ?? 'Invalid request.');
}

export function text(field: string, max = 200, min = 1) {
  const invalid = `Invalid ${field}.`;
  return z.string({ error: invalid }).min(min, invalid).max(max, invalid).refine(value => !value.includes('\0'), invalid);
}

export function identifier(field = 'id') {
  return text(field, 128).refine(value => /^[A-Za-z0-9_-]+$/.test(value), `Invalid ${field}.`);
}

export function userIdentifier(field = 'userId') {
  return text(field, 133).refine(value => /^github:[1-9][0-9]*$/.test(value) || /^test:[A-Za-z0-9_-]{1,128}$/.test(value) || PASSWORD_USER_ID.test(value),
    `Invalid ${field}.`);
}

export interface FieldsOptions {
  required?: readonly string[];
  some?: true;
}

export function fields<T extends z.ZodRawShape>(shape: T, message: string, options: FieldsOptions = {}) {
  const names = Object.keys(shape);
  return z.record(z.string(), z.unknown(), { error: message })
    .refine(value => {
      const keys = Object.keys(value);
      return keys.every(key => names.includes(key)) && (options.required ?? []).every(key => keys.includes(key)) && (!options.some || keys.length > 0);
    }, message)
    .pipe(z.object(shape));
}

export function parsed<T>(parse: (value: unknown) => T, fallback: string) {
  return z.unknown().transform((value, context) => {
    try { return parse(value); } catch (error) {
      context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : fallback });
      return z.NEVER;
    }
  });
}
