/** App settings: a key/value table for config an admin edits from the UI. */
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { appSetting } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

export function getSetting(db: Db, key: string): string | null {
	return db.select().from(appSetting).where(eq(appSetting.key, key)).get()?.value ?? null;
}

/** Upsert one setting. Writes an audit row. Callers inside an operation pass their ctx. */
export function setSetting(ctx: Ctx, key: string, value: string | null): void {
	const row = ctx.db.select().from(appSetting).where(eq(appSetting.key, key)).get();
	if (!row) insert(ctx, appSetting, { key, value });
	else if (row.value !== value) update(ctx, appSetting, row.id, { value });
}
