/**
 * A start imports in a child process, and keeps answering while it does. SQLite calls block, so an
 * import in this process would stop it answering anything, and whatever started OPAL gives it only a
 * short time to answer before killing it, which would stop the import at the same point on every try.
 */
import { removeStoppedImport } from './legacy.ts';

/** The exit code of a child that imported something. 0 means there was nothing to import. */
export const IMPORTED_EXIT = 3;
/** Tells `opal import` it was started by a start, so it stops if that start is gone. */
export const PARENT_ENV = 'OPAL_IMPORT_PARENT';

const PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>OPAL</title><p>OPAL is importing a 1.x database. This page reloads until it is done.</p>`;

/** What the server answers until the database is ready. The health check counts as healthy: the process is working. */
export function importingResponse(req: Request): Response {
	const path = new URL(req.url).pathname;
	if (path === '/api/health') return Response.json({ status: 'importing' });
	if (path.startsWith('/api/') || path.startsWith('/mcp')) return Response.json({ code: 'importing', message: 'OPAL is importing a 1.x database. Try again when it is done.' }, { status: 503, headers: { 'retry-after': '5' } });
	return new Response(PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' } });
}

export type ImportOutcome = 'imported' | 'nothing' | 'failed' | 'stopped';

/** Runs the child with this process's output. A stop asked of this process stops the child and leaves no copy of the old file. */
export async function runImportChild(command: string[], dbPath: string): Promise<ImportOutcome> {
	const proc = Bun.spawn(command, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, [PARENT_ENV]: String(process.pid) } });
	let stopped = false;
	const stop = () => {
		stopped = true;
		proc.kill('SIGTERM');
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	const code = await proc.exited;
	process.off('SIGTERM', stop);
	process.off('SIGINT', stop);
	if (stopped) {
		removeStoppedImport(dbPath);
		return 'stopped';
	}
	return code === IMPORTED_EXIT ? 'imported' : code === 0 ? 'nothing' : 'failed';
}
