/** Serves the built web client: real files as-is, other paths get index.html. */
import type { Hono } from 'hono';
import { statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { embedded } from './embedded.ts';

/** Where `pnpm --filter frontend build` writes the client. */
export const CLIENT_DIR = join(import.meta.dir, '../../../frontend/build');

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Finds the file for a URL path (no leading slash), or nothing. */
type Lookup = (path: string) => ReturnType<typeof Bun.file> | undefined;

function fromDir(root: string): Lookup {
	return (path) => {
		if (!path || path.includes('\0') || path.includes('\\')) return undefined;
		const file = normalize(join(root, path));
		if (!file.startsWith(root + sep)) return undefined;
		try {
			return statSync(file).isFile() ? Bun.file(file) : undefined;
		} catch {
			return undefined;
		}
	};
}

function fromMap(files: Record<string, string>): Lookup {
	return (path) => {
		const file = Object.hasOwn(files, path) ? files[path] : undefined;
		return file ? Bun.file(file) : undefined;
	};
}

/** `root` is a folder of built files. Without it the binary serves its embedded copy. */
export function mountWeb(app: Hono, root?: string): void {
	const bundle = embedded()?.web;
	const lookup = root ? fromDir(normalize(root)) : bundle ? fromMap(bundle) : fromDir(CLIENT_DIR);

	app.get('*', (c) => {
		let path: string;
		try {
			path = decodeURIComponent(c.req.path).replace(/^\/+/, '');
		} catch {
			return c.text('Bad request', 400);
		}
		const [top] = path.split('/');
		// The API and MCP own these prefixes; a miss there is never the app shell.
		if (top === 'api' || top === 'mcp') {
			return c.json({ error: 'not_found', message: 'No such endpoint' }, 404);
		}

		const file = lookup(path);
		if (file) {
			const cache = path.startsWith('_app/immutable/') ? IMMUTABLE : 'no-cache';
			return new Response(file, { headers: { 'content-type': file.type, 'cache-control': cache } });
		}
		// Client routes never carry an extension, so a missing /x.js is a real 404.
		if (path.split('/').pop()?.includes('.')) return c.text('Not found', 404);

		const index = lookup('index.html');
		if (!index) {
			return c.text('Web client not built. Run `pnpm --filter frontend build`.', 503);
		}
		return new Response(index, {
			headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-cache' }
		});
	});
}
