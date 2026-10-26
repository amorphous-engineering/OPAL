/**
 * Attachments: files linked to a record, stored once by content hash.
 *
 * The bytes live in `blobs/<sha256>` in the data folder. An `attachment` row
 * links a blob to exactly one owner. Deleting an attachment removes only the
 * link: the blob file stays, because a published snapshot may reference its
 * hash. `purgeOrphanBlobs` removes blobs nothing references.
 *
 * Other areas call `attach(ctx, { type: 'issue', id }, file)`. The owner type
 * is the owner's table name. A hard-deleted owner calls `detachAll`.
 */
import {
	ATTACHMENT_KINDS,
	type Attachment,
	type AttachmentKind,
	notFound,
	now,
	OpalError
} from '@opal/shared';
import { and, count, desc, eq, inArray, is, notInArray } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import * as schema from '../../db/schema/index.ts';
import { attachment, blob, user } from '../../db/schema/index.ts';
import { dataDir } from '../../paths.ts';
import { insert, remove, update } from '../../write.ts';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MIME_TYPES = [
	'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
	'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'image/vnd.dwg', 'application/acad', 'application/x-acad',
	'model/step+xml', 'application/step', 'application/x-step',
	'model/stl', 'application/sla', 'application/vnd.ms-pki.stl',
	'application/zip', 'application/json'
];

/** `OPAL_MAX_UPLOAD_BYTES` and `OPAL_ALLOWED_MIME_TYPES` (comma separated) override the defaults. */
export const maxUploadBytes = () => Number(process.env.OPAL_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;
export const allowedMimeTypes = () =>
	process.env.OPAL_ALLOWED_MIME_TYPES
		? process.env.OPAL_ALLOWED_MIME_TYPES.split(',').map((m) => m.trim())
		: DEFAULT_MIME_TYPES;

export const blobDir = () => join(dataDir(), 'blobs');
export const blobPath = (sha256: string) => join(blobDir(), sha256);

// ---------------------------------------------------------------- blob store

export function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** Write the bytes under their hash (once) and record the blob. Returns the hash. */
export async function storeBlob(db: Db, bytes: Uint8Array, mimeType: string): Promise<string> {
	const sha = sha256Hex(bytes);
	const path = blobPath(sha);
	const exists = await stat(path).then(
		() => true,
		() => false
	);
	if (!exists) {
		await mkdir(blobDir(), { recursive: true });
		const tmp = `${path}.${crypto.randomUUID()}.tmp`;
		await writeFile(tmp, bytes);
		await rename(tmp, path);
	}
	db.insert(blob)
		.values({ sha256: sha, sizeBytes: bytes.byteLength, mimeType, createdAt: now() })
		.onConflictDoNothing()
		.run();
	return sha;
}

export function getBlob(db: Db, sha256: string) {
	return db.select().from(blob).where(eq(blob.sha256, sha256)).get();
}

/**
 * Remove blob files and rows that no attachment links to and that no other
 * area claims. `isReferenced` is each area's check for hashes it holds (for
 * example published snapshots). Not called automatically.
 */
export async function purgeOrphanBlobs(
	db: Db,
	isReferenced: ((sha256: string) => boolean)[] = []
): Promise<number> {
	const linked = db.selectDistinct({ sha: attachment.blobSha256 }).from(attachment).all().map((r) => r.sha);
	const orphans = (linked.length
		? db.select().from(blob).where(notInArray(blob.sha256, linked)).all()
		: db.select().from(blob).all()
	).filter((b) => !isReferenced.some((f) => f(b.sha256)));
	for (const b of orphans) {
		await unlink(blobPath(b.sha256)).catch(() => undefined);
		db.delete(blob).where(eq(blob.sha256, b.sha256)).run();
	}
	return orphans.length;
}

// -------------------------------------------------------------------- owners

export interface Owner {
	type: string;
	id: number;
}

const tables = new Map<string, SQLiteTable & { id: any }>();
function ownerTable(type: string) {
	if (tables.size === 0) {
		for (const v of Object.values(schema)) {
			if (is(v, SQLiteTable)) tables.set(getTableName(v), v as SQLiteTable & { id: any });
		}
	}
	return tables.get(type);
}

function assertOwner(db: Db, owner: Owner): void {
	const table = ownerTable(owner.type);
	if (!table?.id || owner.type === 'attachment' || owner.type === 'blob') {
		throw new OpalError(422, 'invalid_input', 'Invalid input', { ownerType: `unknown owner type ${owner.type}` });
	}
	if (!db.select({ id: table.id }).from(table).where(eq(table.id, owner.id)).get()) {
		throw notFound(`Owner ${owner.type}`);
	}
}

// -------------------------------------------------------------------- guards

export type OwnerChange =
	| { action: 'attach' }
	| { action: 'patch' | 'detach'; attachment: { id: number; kind: AttachmentKind | null } };

type OwnerGuard = (ctx: Ctx, ownerId: number, change: OwnerChange) => void;
const guards = new Map<string, OwnerGuard>();

/**
 * An area that freezes its records registers a veto per owner type. Only the operation path
 * (`guardAttach`, `guardChange`) asks it. Internal callers of `attach` and `detach` do not.
 */
export function registerOwnerGuard(ownerType: string, guard: OwnerGuard): void {
	guards.set(ownerType, guard);
}

export function guardAttach(ctx: Ctx, owner: Owner): void {
	assertOwner(ctx.db, owner);
	guards.get(owner.type)?.(ctx, owner.id, { action: 'attach' });
}

/** For the patch and detach operations: runs the guard of the attachment's owner type. */
export function guardChange(ctx: Ctx, id: number, action: 'patch' | 'detach'): void {
	const a = ctx.db.select().from(attachment).where(eq(attachment.id, id)).get();
	if (!a) throw notFound('Attachment');
	guards.get(a.ownerType)?.(ctx, a.ownerId, { action, attachment: { id: a.id, kind: a.kind } });
}

// ------------------------------------------------------------------- service

type Row = typeof attachment.$inferSelect;

function present(db: Db, rows: Row[]): Attachment[] {
	if (rows.length === 0) return [];
	const blobs = new Map(
		db.select().from(blob).where(inArray(blob.sha256, [...new Set(rows.map((r) => r.blobSha256))])).all().map((b) => [b.sha256, b])
	);
	const ids = [...new Set(rows.map((r) => r.uploadedById).filter((x): x is number => x != null))];
	const names = new Map(
		ids.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)).all().map((u) => [u.id, u.name]) : []
	);
	return rows.map((r) => {
		const b = blobs.get(r.blobSha256)!;
		return {
			id: r.id,
			sha256: r.blobSha256,
			filename: r.filename,
			mimeType: b.mimeType,
			sizeBytes: b.sizeBytes,
			ownerType: r.ownerType,
			ownerId: r.ownerId,
			kind: r.kind,
			note: r.note,
			uploadedById: r.uploadedById,
			uploadedByName: r.uploadedById == null ? null : (names.get(r.uploadedById) ?? null),
			createdAt: r.createdAt,
			href: `/api/attachments/${r.id}/download`
		};
	});
}

export interface FileInput {
	/** Original file name. Path separators are replaced. */
	name: string;
	/** Declared content type. Must be on the allowed list. */
	type: string;
	bytes: Uint8Array;
	kind?: AttachmentKind | null;
	note?: string | null;
}

export function cleanFilename(name: string): string {
	return (name || 'unnamed').replaceAll('/', '_').replaceAll('\\', '_').slice(0, 200);
}

/** Validate, store and link a file. The one function other areas call. */
export async function attach(ctx: Ctx, owner: Owner, file: FileInput): Promise<Attachment> {
	if (file.kind != null && !(ATTACHMENT_KINDS as readonly string[]).includes(file.kind)) {
		throw new OpalError(422, 'invalid_input', 'Invalid input', { kind: `must be one of ${ATTACHMENT_KINDS.join(', ')}` });
	}
	// "text/plain;charset=utf-8" is text/plain.
	const mime = file.type.split(';')[0]!.trim().toLowerCase();
	if (!allowedMimeTypes().includes(mime)) {
		throw new OpalError(422, 'file_type_not_allowed', `File type '${mime}' is not allowed`, { file: 'type not allowed' });
	}
	if (file.bytes.byteLength > maxUploadBytes()) {
		throw new OpalError(413, 'file_too_large', `File too large (${file.bytes.byteLength} bytes). Max: ${maxUploadBytes()} bytes`);
	}
	assertOwner(ctx.db, owner);
	const sha = await storeBlob(ctx.db, file.bytes, mime);
	const row = insert(ctx, attachment, {
		blobSha256: sha,
		filename: cleanFilename(file.name),
		ownerType: owner.type,
		ownerId: owner.id,
		kind: file.kind ?? null,
		note: file.note ?? null,
		uploadedById: actorUserId(ctx.actor)
	});
	return present(ctx.db, [row])[0]!;
}

export function listFor(ctx: Ctx, owner: Owner, kind?: AttachmentKind): Attachment[] {
	const rows = ctx.db
		.select()
		.from(attachment)
		.where(
			and(
				eq(attachment.ownerType, owner.type),
				eq(attachment.ownerId, owner.id),
				kind ? eq(attachment.kind, kind) : undefined
			)
		)
		.orderBy(desc(attachment.createdAt), desc(attachment.id))
		.limit(200)
		.all();
	return present(ctx.db, rows);
}

export function get(ctx: Ctx, id: number): Attachment {
	const row = ctx.db.select().from(attachment).where(eq(attachment.id, id)).get();
	if (!row) throw notFound('Attachment');
	return present(ctx.db, [row])[0]!;
}

export function patch(ctx: Ctx, id: number, input: { kind?: AttachmentKind | null; note?: string | null }): Attachment {
	get(ctx, id);
	const changes: { kind?: AttachmentKind | null; note?: string | null } = {};
	if (input.kind !== undefined) changes.kind = input.kind;
	if (input.note !== undefined) changes.note = input.note;
	const row = Object.keys(changes).length
		? update(ctx, attachment, id, changes)
		: ctx.db.select().from(attachment).where(eq(attachment.id, id)).get()!;
	return present(ctx.db, [row])[0]!;
}

/** Remove the link only. The blob stays. */
export function detach(ctx: Ctx, id: number): void {
	get(ctx, id);
	remove(ctx, attachment, id);
}

/** For an owner that is hard-deleted: drop all its links. Returns how many. */
export function detachAll(ctx: Ctx, owner: Owner): number {
	const rows = ctx.db
		.select({ id: attachment.id })
		.from(attachment)
		.where(and(eq(attachment.ownerType, owner.type), eq(attachment.ownerId, owner.id)))
		.all();
	for (const r of rows) remove(ctx, attachment, r.id);
	return rows.length;
}

/** Number of links to a blob. */
export function linkCount(db: Db, sha256: string): number {
	return db.select({ n: count() }).from(attachment).where(eq(attachment.blobSha256, sha256)).get()?.n ?? 0;
}

/** Row for the download route. */
export function row(db: Db, id: number) {
	const a = db.select().from(attachment).where(eq(attachment.id, id)).get();
	if (!a) throw notFound('Attachment');
	return { link: a, blob: getBlob(db, a.blobSha256)! };
}
