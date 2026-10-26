/**
 * Routes that are not JSON operations: browser redirects, file upload and download,
 * event streams. Each area exports one mount function; the lead lists it here.
 */
import type { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import type { ResolveActor } from '../registry.ts';
import { mountOidc } from '../auth/oidc.ts'; // added by auth
import { mountAvatarRoute } from '../services/org/avatars.ts';
import { mountFiles } from '../services/platform/files.ts';
import { mountPluginProxy } from '../services/plugins/proxy.ts';
import { mountProcedureRoutes } from '../services/procedures/routes.ts'; // added by procedures

export function mountRawRoutes(app: Hono, db: Db, resolveActor: ResolveActor): void {
	mountAvatarRoute(app, db, resolveActor);
	mountFiles(app, db, { resolveActor });
	mountOidc(app, db); // added by auth
	mountProcedureRoutes(app, db, resolveActor); // added by procedures
	mountPluginProxy(app, db, resolveActor);
}
