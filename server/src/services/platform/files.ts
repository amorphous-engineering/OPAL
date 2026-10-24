/**
 * The platform routes that are not JSON operations. Mount with
 * `mountFiles(app, db)` in app.ts, after `mountOps` and BEFORE the
 * `/api/*` not-found catch-all:
 *
 *   POST /api/attachments                multipart: file, ownerType, ownerId, kind?, note?
 *   GET  /api/attachments/:id/download   the file, with its content type and a Content-Disposition
 *   GET  /api/blobs/:sha256              the file by content hash (inline images in snapshots)
 *   GET  /api/events/stream              server-sent events
 */
import { op, OpalError, unauthenticated, ATTACHMENT_KINDS, zAttachment, zId } from '@opal/shared';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { actorUserId } from '../../context.ts';
import { actorResolver } from '../../auth/index.ts';
import type { Db } from '../../db/client.ts';
import { type Impl, implement, type ResolveActor, runOp } from '../../registry.ts';
import { attach, blobPath, getBlob, maxUploadBytes, row } from './attachments.ts';
import { subscribe } from './events.ts';

/** Not in the shared contract tree: the body is a file, so no JSON client call exists for it. */
const uploadContract = op({
	name: 'attachments.upload',
	method: 'POST',
	path: '/attachments',
	summary: 'Upload a file and attach it to a record.',
	input: z.object({
		file: z.custom<File>((v) => v instanceof File, 'a file is required'),
		ownerType: z.string().min(1),
		ownerId: zId,
		kind: z.enum(ATTACHMENT_KINDS).nullish(),
		note: z.string().max(2000).nullish()
	}),
	output: zAttachment,
	access: 'signed-in',
	mcp: false
});

const uploadImpl: Impl = implement(uploadContract, async (ctx, input) =>
	attach(
		ctx,
		{ type: input.ownerType, id: input.ownerId },
		{
			name: input.file.name,
			type: input.file.type,
			bytes: new Uint8Array(await input.file.arrayBuffer()),
			kind: input.kind,
			note: input.note
		}
	)
);

/** Types a browser may render in place. Everything else downloads (SVG and HTML can carry script). */
const INLINE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/;

function fileResponse(path: string, mime: string, filename: string | null, forceDownload: boolean): Response {
	const inline = INLINE.test(mime) && !forceDownload;
	const headers: Record<string, string> = {
		'Content-Type': mime,
		'Content-Disposition': filename
			? `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
			: inline
				? 'inline'
				: 'attachment',
		'X-Content-Type-Options': 'nosniff',
		// Uploaded content never runs script in our origin.
		'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
		'Cache-Control': 'private, max-age=3600'
	};
	return new Response(Bun.file(path), { headers });
}

/** Bun closes a connection idle for 10 s by default, so the stream speaks more often than that. */
const HEARTBEAT_MS = 5_000;

export interface FilesOptions {
	resolveActor?: ResolveActor;
}

export function mountFiles(app: Hono, db: Db, { resolveActor = actorResolver(db) }: FilesOptions = {}): void {
	const actorOf = async (c: Context) => {
		const actor = await resolveActor(c);
		if (actor.kind === 'anonymous') throw unauthenticated();
		return actor;
	};

	app.post(
		'/api/attachments',
		bodyLimit({
			maxSize: maxUploadBytes() + 1024 * 1024,
			onError: (c) => c.json({ error: 'file_too_large', message: 'File too large' }, 413)
		}),
		async (c) => {
			const actor = await actorOf(c);
			const form = await c.req.parseBody();
			const text = (k: string) => (typeof form[k] === 'string' && form[k] !== '' ? (form[k] as string) : undefined);
			const out = await runOp(uploadImpl, db, actor, {
				file: form.file,
				ownerType: text('ownerType'),
				ownerId: text('ownerId'),
				kind: text('kind'),
				note: text('note')
			});
			return c.json(out as object, 201);
		}
	);

	app.get('/api/attachments/:id/download', async (c) => {
		await actorOf(c);
		const { link, blob } = row(db, Number(c.req.param('id')));
		return fileResponse(blobPath(blob.sha256), blob.mimeType, link.filename, c.req.query('download') === '1');
	});

	app.get('/api/blobs/:sha256', async (c) => {
		await actorOf(c);
		const sha = c.req.param('sha256');
		const b = /^[0-9a-f]{64}$/.test(sha) ? getBlob(db, sha) : undefined;
		if (!b) throw new OpalError(404, 'not_found', 'File not found');
		const res = fileResponse(blobPath(sha), b.mimeType, null, c.req.query('download') === '1');
		res.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
		return res;
	});

	app.get('/api/events/stream', async (c) => {
		const actor = await actorOf(c);
		return streamSSE(c, async (stream) => {
			const unsubscribe = subscribe(actorUserId(actor), (event) => {
				void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => undefined);
			});
			stream.onAbort(unsubscribe);
			// First frame lets EventSource.onopen fire and proxies flush headers.
			await stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat', data: { status: 'alive' }, timestamp: new Date().toISOString() }) });
			while (!stream.aborted && !stream.closed) {
				await stream.sleep(HEARTBEAT_MS);
				if (stream.aborted) break;
				await stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat', data: { status: 'alive' }, timestamp: new Date().toISOString() }) });
			}
			unsubscribe();
		});
	});
}
