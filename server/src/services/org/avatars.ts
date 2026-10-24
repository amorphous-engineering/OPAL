/**
 * User avatars. A file is stored under `<data dir>/avatars/<sha256>` and the profile row names
 * it by hash, so equal images share one file. `avatarSource`: upload | oidc | removed
 * (removed: the identity provider must not refill it) | null.
 *
 * To move to the platform blob store: replace `writeAvatarFile`, `readAvatarFile` and
 * `deleteAvatarFile` with blob put/get/release calls. The profile column `avatar_hash`
 * already holds the content hash.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_TYPES, MAX_AVATAR_BYTES, OpalError, notFound, now } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Ctx } from '../../context.ts';
import { userProfile } from '../../db/schema/index.ts';
import { dataDir } from '../../paths.ts';
import type { ResolveActor } from '../../registry.ts';
import { upsertProfile } from './profiles.ts';

const avatarDir = () => join(dataDir(), 'avatars');

/** The mime type of PNG/JPEG/WebP/GIF bytes, from the magic number. */
export function sniffImage(d: Uint8Array): (typeof AVATAR_TYPES)[number] | null {
	const at = (i: number, ...b: number[]) => b.every((v, k) => d[i + k] === v);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (d[4] === 0x37 || d[4] === 0x39) && d[5] === 0x61) return 'image/gif';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	return null;
}

async function writeAvatarFile(hash: string, bytes: Uint8Array): Promise<void> {
	mkdirSync(avatarDir(), { recursive: true });
	await writeFile(join(avatarDir(), hash), bytes);
}
const readAvatarFile = (hash: string) => readFile(join(avatarDir(), hash));
const deleteAvatarFile = (hash: string) => rm(join(avatarDir(), hash), { force: true });

/** Store `bytes` as the avatar of a user. Checks type and size. The caller has checked access. */
export async function setAvatar(
	ctx: Ctx,
	userId: number,
	bytes: Uint8Array,
	source: 'upload' | 'oidc'
): Promise<void> {
	if (bytes.length > MAX_AVATAR_BYTES) {
		throw new OpalError(413, 'too_large', `Avatar too large. Max: ${MAX_AVATAR_BYTES} bytes`);
	}
	const mime = sniffImage(bytes);
	if (!mime) throw new OpalError(400, 'invalid_image', 'File is not a PNG, JPEG, WebP or GIF image');
	const hash = createHash('sha256').update(bytes).digest('hex');
	await writeAvatarFile(hash, bytes);
	const before = ctx.db.select().from(userProfile).where(eq(userProfile.userId, userId)).get();
	upsertProfile(ctx, userId, { avatarHash: hash, avatarMime: mime, avatarSource: source, avatarUpdatedAt: now() });
	if (before?.avatarHash && before.avatarHash !== hash) await releaseIfUnused(ctx, before.avatarHash);
}

export async function removeAvatar(ctx: Ctx, userId: number): Promise<void> {
	const before = ctx.db.select().from(userProfile).where(eq(userProfile.userId, userId)).get();
	upsertProfile(ctx, userId, { avatarHash: null, avatarMime: null, avatarSource: 'removed', avatarUpdatedAt: now() });
	if (before?.avatarHash) await releaseIfUnused(ctx, before.avatarHash);
}

async function releaseIfUnused(ctx: Ctx, hash: string): Promise<void> {
	if (!ctx.db.select({ id: userProfile.id }).from(userProfile).where(eq(userProfile.avatarHash, hash)).get()) {
		await deleteAvatarFile(hash);
	}
}

export function decodeBase64(data: string): Uint8Array {
	const clean = data.replace(/^data:[^,]*,/, '');
	return new Uint8Array(Buffer.from(clean, 'base64'));
}

/**
 * `GET /api/users/:id/avatar`: the image itself. Operations return JSON, so this one route is
 * mounted next to them by `createApp`. It needs a signed-in actor.
 */
export function mountAvatarRoute(app: Hono, db: Ctx['db'], resolveActor: ResolveActor): void {
	app.get('/api/users/:id/avatar', async (c) => {
		const actor = await resolveActor(c);
		if (actor.kind === 'anonymous') {
			return c.json({ error: 'unauthenticated', message: 'Sign in required' }, 401);
		}
		const id = Number(c.req.param('id'));
		const p = Number.isInteger(id) ? db.select().from(userProfile).where(eq(userProfile.userId, id)).get() : undefined;
		if (!p?.avatarHash || p.avatarSource === 'removed') throw notFound('Avatar');
		let bytes: Buffer;
		try {
			bytes = await readAvatarFile(p.avatarHash);
		} catch {
			throw notFound('Avatar');
		}
		return new Response(new Uint8Array(bytes), {
			headers: {
				'Content-Type': p.avatarMime ?? 'application/octet-stream',
				'Cache-Control': 'private, max-age=31536000',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	});
}
