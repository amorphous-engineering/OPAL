/** user_profile rows: one per user, created on the first write. */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { userProfile } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

type Patch = Partial<Omit<typeof userProfile.$inferInsert, 'userId' | 'createdAt' | 'updatedAt'>>;

export function getProfile(db: Db, userId: number) {
	return db.select().from(userProfile).where(eq(userProfile.userId, userId)).get();
}

export function upsertProfile(ctx: Ctx, userId: number, patch: Patch) {
	const row = getProfile(ctx.db, userId);
	if (!row) return insert(ctx, userProfile, { userId, ...patch });
	return update(ctx, userProfile, row.id, patch);
}

export function timeDisplayOf(db: Db, userId: number): 'local' | 'utc' {
	return getProfile(db, userId)?.timeDisplay ?? 'local';
}

/** Flags that drive the first-run screens. A user without a row still owes the orientation. */
export function profileState(db: Db, userId: number) {
	const p = getProfile(db, userId);
	return { needsProfileSetup: p?.needsProfileSetup ?? false, needsOnboarding: p?.needsOnboarding ?? true };
}
