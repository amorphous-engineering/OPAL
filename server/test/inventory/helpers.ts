import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor, Ctx } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { appSetting, part, user } from '../../src/db/schema/index.ts';
import { openTestDb } from '../helpers/db.ts';

export interface PartOptions {
	name?: string;
	tracking?: 'bulk' | 'serialized';
	tier?: number;
	state?: 'draft' | 'active' | 'obsolete';
	isTooling?: boolean;
	calibrationIntervalDays?: number | null;
	reorderPoint?: number | null;
	unitOfMeasure?: string;
}

let seq = 0;

export function makePart(db: Db, o: PartOptions = {}) {
	seq += 1;
	const ts = now();
	return db
		.insert(part)
		.values({
			internalPn: `T-${String(seq).padStart(4, '0')}`,
			name: o.name ?? `Part ${seq}`,
			unitOfMeasure: o.unitOfMeasure ?? 'ea',
			trackingType: o.tracking ?? 'bulk',
			procurement: 'buy',
			tier: o.tier ?? 3,
			state: o.state ?? 'active',
			isTooling: o.isTooling ?? false,
			calibrationIntervalDays: o.calibrationIntervalDays ?? null,
			reorderPoint: o.reorderPoint ?? null,
			createdAt: ts,
			updatedAt: ts
		})
		.returning()
		.get();
}

/** An admin user, a Hono app that acts as that user, and a context for calling services. */
export async function setup(actorOverride?: Actor) {
	const db = await openTestDb();
	const ts = now();
	const admin = db
		.insert(user)
		.values({ username: 'admin', name: 'Ada Admin', isAdmin: true, createdAt: ts, updatedAt: ts })
		.returning()
		.get();
	const actor: Actor = actorOverride ?? {
		kind: 'user',
		userId: admin.id,
		isAdmin: true,
		sessionId: 1
	};
	const app = createApp({ db, resolveActor: () => actor });
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};
	const ctx: Ctx = { db, actor, op: 'test' };
	return { db, app, call, ctx, admin };
}

/** Store a project configuration so tier rules apply. */
export function setProject(db: Db, tiers: Array<Record<string, unknown>>) {
	const ts = now();
	db.insert(appSetting)
		.values({ key: 'project_config', value: JSON.stringify({ name: 'T', tiers }), createdAt: ts, updatedAt: ts })
		.run();
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/** Receive stock through the API and return the first record. */
export async function receive(
	s: Setup,
	partId: number,
	quantity: string,
	location = 'A1',
	extra: Record<string, unknown> = {}
) {
	const r = await s.call('POST', '/inventory', { partId, quantity, location, ...extra });
	if (r.status !== 201) throw new Error(`receive failed: ${JSON.stringify(r.body)}`);
	return r.body.items[0];
}
