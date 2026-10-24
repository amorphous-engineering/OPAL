/** Builds the HTTP app: /api operations, /mcp, then the web client. */
import { Hono } from 'hono';
import { csrfGuard } from './auth/csrf.ts';
import { actorResolver } from './auth/index.ts';
import type { Db } from './db/client.ts';
import { mountRawRoutes } from './http/routes.ts';
import { mountWeb } from './http/web.ts';
import { mountMcp } from './mcp/index.ts';
import { impls } from './ops/index.ts';
import { errorResponse, mountOps, type ResolveActor } from './registry.ts';
import { ensureFts } from './services/platform/search.ts';

export interface AppOptions {
	db: Db;
	/** Tests pass a fixed actor. Production resolves it from the request. */
	resolveActor?: ResolveActor;
	/** Serve the web client. Off in tests. */
	web?: boolean;
}

export function createApp({ db, resolveActor = actorResolver(db), web = false }: AppOptions): Hono {
	// Search indexes are FTS5 virtual tables, outside Drizzle: create any that are missing.
	ensureFts(db);
	const app = new Hono();
	app.onError((err, c) => {
		const { status, body } = errorResponse(err);
		return c.json(body, status as 400);
	});
	app.get('/api/health', (c) => c.json({ ok: true }));
	app.use('*', csrfGuard);
	mountRawRoutes(app, db, resolveActor);
	mountOps(app, impls, db, resolveActor);
	app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such endpoint' }, 404));
	mountMcp(app, impls, db, resolveActor);
	if (web) mountWeb(app);
	return app;
}
