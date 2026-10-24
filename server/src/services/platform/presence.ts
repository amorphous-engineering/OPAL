/**
 * Presence: who is online and what each person is doing. In memory only, so
 * it resets on restart and never touches the `user` table.
 */
import { now, type Presence } from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { user } from '../../db/schema/index.ts';
import { publish } from './events.ts';

/** A heartbeat arrives every 15 s; three missed beats means offline. */
export const ONLINE_WINDOW_MS = 45_000;

interface Entry {
	activity: string | null;
	seenAt: number;
}
const entries = new Map<number, Entry>();

/** For tests. */
export function resetPresence(): void {
	entries.clear();
}

export function heartbeat(db: Db, userId: number, activity: string | null | undefined): Presence[] {
	const t = Date.now();
	const prev = entries.get(userId);
	const wasOnline = prev !== undefined && t - prev.seenAt <= ONLINE_WINDOW_MS;
	const next = activity === undefined ? (prev?.activity ?? null) : activity;
	entries.set(userId, { activity: next, seenAt: t });
	if (!wasOnline || prev?.activity !== next) {
		const name = db.select({ name: user.name }).from(user).where(eq(user.id, userId)).get()?.name;
		publish({ type: 'user_activity', data: { userId, userName: name ?? null, activity: next } });
	}
	return listOnline(db);
}

export function listOnline(db: Db): Presence[] {
	const t = Date.now();
	for (const [id, e] of entries) if (t - e.seenAt > ONLINE_WINDOW_MS * 4) entries.delete(id);
	const live = [...entries].filter(([, e]) => t - e.seenAt <= ONLINE_WINDOW_MS);
	if (live.length === 0) return [];
	const names = new Map(
		db
			.select({ id: user.id, name: user.name })
			.from(user)
			.where(
				inArray(
					user.id,
					live.map(([id]) => id)
				)
			)
			.all()
			.map((u) => [u.id, u.name])
	);
	return live
		.filter(([id]) => names.has(id))
		.map(([id, e]) => ({
			userId: id,
			name: names.get(id)!,
			activity: e.activity,
			lastSeenAt: new Date(e.seenAt).toISOString()
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
