import { HTTPException } from 'hono/http-exception';
import type { Env } from '../types.js';
import { fail } from '../http.js';
import { auditAfterChange } from './audit.js';

export const githubSignInExpired = 'github_sign_in_expired';

export async function forgetDeadGitHubToken(env: Env, userId: string, ciphertext: string, reason: string): Promise<void> {
  await env.DB.batch([
    env.DB.query('DELETE FROM github_tokens WHERE user_id = ? AND ciphertext = ?').bind(userId, ciphertext),
    auditAfterChange(env, userId, 'git.account.expired', null, { accountId: 'github', provider: 'github', host: 'github.com', organization: '', reason }),
  ]);
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
