import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, project, user } from '../../src/db/schema/index.ts';
import { openTestDb } from '../helpers/db.ts';

/** A database, the full app, and shorthands for building procedures. */
export async function setup() {
	process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-procedures-'));
	const db: Db = await openTestDb();
	let current: Actor = { kind: 'system' };
	const app = createApp({ db, resolveActor: () => current });

	const ts = now();
	const row = db
		.insert(user)
		.values({ username: 'author', name: 'Author', email: 'a@x.local', isAdmin: true, createdAt: ts, updatedAt: ts })
		.returning()
		.get();
	const author: Actor = { kind: 'user', userId: row.id, isAdmin: true, sessionId: 0 };
	const tokenRow = db.insert(apiToken).values({ userId: row.id, name: 't', tokenHash: 'h', createdAt: ts }).returning().get();
	const token: Actor = { kind: 'token', userId: row.id, isAdmin: true, tokenId: tokenRow.id };
	current = author;
	const proj = db.insert(project).values({ code: 'KES', name: 'Kestrel', createdAt: ts, updatedAt: ts }).returning().get();

	async function call(method: string, path: string, body?: unknown, as: Actor = author) {
		current = as;
		const res = await app.request(`/api${path}`, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await res.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text, headers: res.headers };
	}
	const ok = async (method: string, path: string, body?: unknown) => {
		const r = await call(method, path, body);
		if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text}`);
		return r.json;
	};

	const proc = (name = 'Procedure', extra: Record<string, unknown> = {}) => ok('POST', '/procedures', { projectId: proj.id, name, ...extra });
	const step = (pid: number, title: string, extra: Record<string, unknown> = {}) =>
		ok('POST', `/procedures/${pid}/steps`, { title, ...extra });
	const draft = async (pid: number) => (await ok('GET', `/procedures/${pid}/draft`)).steps as any[];
	const numbers = async (pid: number) => (await draft(pid)).map((s) => [s.number, s.title]);
	/** OP one [a, b], OP two [c]. */
	async function tree(pid: number) {
		const op1 = await step(pid, 'OP one');
		const op2 = await step(pid, 'OP two');
		const a = await step(pid, 'a', { parentId: op1.id });
		const b = await step(pid, 'b', { parentId: op1.id });
		const c = await step(pid, 'c', { parentId: op2.id });
		return { op1, op2, a, b, c };
	}
	const part = async (name: string, activate = true) => {
		const p = await ok('POST', '/parts', { name, tier: 1 });
		if (activate) await ok('POST', `/parts/${p.id}/activate`, { cause: 'test' });
		return p;
	};
	/** A published procedure with the given OP titles. */
	async function published(name = 'Published', titles = ['A', 'B']) {
		const p = await proc(name);
		for (const t of titles) await step(p.id, t);
		const v = await ok('POST', `/procedures/${p.id}/publish`, {});
		return { id: p.id as number, version: v };
	}
	const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, Math.floor(Math.random() * 255)])], 'x.png', { type: 'image/png' });
	async function upload(pid: number, stepId: number, file: File, caption?: string) {
		const form = new FormData();
		form.set('file', file);
		if (caption) form.set('caption', caption);
		current = author;
		const res = await app.request(`/api/procedures/${pid}/steps/${stepId}/images`, { method: 'POST', body: form });
		return { status: res.status, json: (await res.json()) as any };
	}
	return { proj, db, app, call, ok, proc, step, draft, numbers, tree, part, published, upload, png, author, token };
}
