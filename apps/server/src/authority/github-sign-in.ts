import { HTTPException } from 'hono/http-exception';
import type { Env } from '../types.js';
import { fail } from '../http.js';
import { auditAfterChange } from './audit.js';

export const githubSignInExpired = 'github_sign_in_expired';

const tokenResets = new Map<string, Promise<void>>();

export function resettingGitHubToken<T>(userId: string, reset: () => Promise<T>): Promise<T> {
  const result = (tokenResets.get(userId) ?? Promise.resolve()).then(reset);
  const settled = result.then(() => {}, () => {});
  tokenResets.set(userId, settled);
  void settled.then(() => { if (tokenResets.get(userId) === settled) tokenResets.delete(userId); });
  return result;
}

export async function gitHubTokenSettled(userId: string): Promise<void> {
  for (let pending = tokenResets.get(userId); pending; pending = tokenResets.get(userId)) await pending;
}

export async function dropDeadGitHubToken(env: Env, userId: string, ciphertext: string, reason: string): Promise<void> {
  await env.DB.batch([
    env.DB.query('DELETE FROM github_tokens WHERE user_id = ? AND ciphertext = ?').bind(userId, ciphertext),
    auditAfterChange(env, userId, 'git.account.expired', null, { accountId: 'github', provider: 'github', host: 'github.com', organization: '', reason }),
  ]);
}

export async function forgetDeadGitHubToken(env: Env, userId: string, ciphertext: string, reason: string): Promise<void> {
  await gitHubTokenSettled(userId);
  await dropDeadGitHubToken(env, userId, ciphertext, reason);
}

export function failGitHubSignInExpired(): never {
  return fail(409, githubSignInExpired, 'GitHub no longer accepts Pikibun\'s sign-in for the session owner (its token was revoked or replaced). '
    + 'They sign in to Pikibun with GitHub again; until then nothing acts as them on GitHub.');
}

export async function failureCode(error: unknown): Promise<string | undefined> {
  if (!(error instanceof HTTPException)) return undefined;
  try {
    const body = await error.getResponse().clone().json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch { return undefined; }
}
