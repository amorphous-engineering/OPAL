import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { part, user } from '../../src/db/schema/index.ts';
import { issueHooks, platformDeliver } from '../../src/services/issues/hooks.ts';
import { openTestDb } from '../helpers/db.ts';

export async function setup() {
	const db = await openTestDb();
	const ts = now();
	const mkUser = (username: string, isAdmin: boolean) =>
		db
			.insert(user)
			.values({ username, name: username.toUpperCase(), isAdmin, createdAt: ts, updatedAt: ts })
			.returning()
			.get();
	const admin = mkUser('abby', true);
	const other = mkUser('ben', true);
	const plain = mkUser('cat', false);
	const asUser = (u: { id: number; isAdmin: boolean }): Actor => ({
		kind: 'user',
		userId: u.id,
		isAdmin: u.isAdmin,
		sessionId: 1
	});
	let who: Actor = asUser(admin);
	const app = createApp({ db, resolveActor: () => who });
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		return { status: res.status, body: (await res.json().catch(() => null)) as any };
	};
	const mkPart = (name: string, pn: string) =>
		db
			.insert(part)
			.values({
				internalPn: pn,
				name,
				unitOfMeasure: 'ea',
				trackingType: 'bulk',
				procurement: 'make',
				tier: 1,
				createdAt: ts,
				updatedAt: ts
			})
			.returning()
			.get();
	// Hooks are module state: reset them for each test.
	issueHooks.deliver = platformDeliver;
	issueHooks.resolveStep = null;
	issueHooks.executionExists = null;
	issueHooks.describe = null;
	issueHooks.stepOptions = null;
	issueHooks.detailExtras = null;
	issueHooks.holdChanged.length = 0;
	return {
		db,
		call,
		admin,
		other,
		plain,
		mkPart,
		as: (u: typeof admin | Actor) => {
			who = 'kind' in u ? u : asUser(u);
		},
		raise: async (body: Record<string, unknown> = {}) => {
			const r = await call('POST', '/issues', { title: 'T', ...body });
			if (r.status !== 201) throw new Error(JSON.stringify(r.body));
			return r.body;
		},
		sign: (id: number, dispositionType = 'use_as_is', dispositionRationale = 'acceptable as built') =>
			call('POST', `/issues/${id}/disposition`, { dispositionType, dispositionRationale })
	};
}
