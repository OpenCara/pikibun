import type { Hono } from 'hono';
import { hostDirectoryRule, validHostDirectory } from '../../../packages/shared/src/host-directory.js';
import { hostDirectoriesAuthority } from './authority/index.js';
import { hostDirectoriesConnectorRequest } from './connector-transport.js';
import { fail, identifier } from './http.js';
import type { AppEnv } from './types.js';

export function registerHostDirectories(app: Hono<AppEnv>): void {
  app.get('/api/connectors/:id/directories', async c => {
    const connectorId = identifier(c.req.param('id'));
    const path = c.req.query('path') || '~';
    if (!validHostDirectory(path)) fail(400, 'invalid_path', `The directory is ${hostDirectoryRule}.`);
    const { ownerId } = await hostDirectoriesAuthority(c.env, connectorId, c.get('auth').userId);
    const directories = await hostDirectoriesConnectorRequest(c, connectorId, ownerId, path);
    c.header('Cache-Control', 'no-store');
    return c.json({ directories });
  });
}
