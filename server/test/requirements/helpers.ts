import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { part, user } from '../../src/db/schema/index.ts';
import { openTestDb } from '../helpers/db.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects

export const GOOD = 'The engine shall sustain a chamber pressure of 20 bar ± 1 bar.';

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
	const plain = mkUser('cat', false);
	const asUser = (u: { id: number; isAdmin: boolean }): Actor => ({
		kind: 'user',
		userId: u.id,
		isAdmin: u.isAdmin,
		sessionId: 1
	});
	let who: Actor = asUser(admin);
	const app = createApp({ db, resolveActor: () => who });
	const project = createTestProject(db); // added by projects
	const scoped = new Set(['/requirements']); // added by projects: creates that need a project
	const call = async (method: string, path: string, body?: unknown) => {
		if (method === 'POST' && scoped.has(path) && body && typeof body === 'object' && !('projectId' in body)) {
			body = { ...body, projectId: project.id }; // added by projects
		}
		const res = await app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		return { status: res.status, body: (await res.json().catch(() => null)) as any };
	};
	const req = async (over: Record<string, unknown> = {}) => {
		const r = await call('POST', '/requirements', {
			title: 'Chamber pressure',
			statement: GOOD,
			rationale: 'Sized from the mission delta-v budget.',
			verificationMethod: 'test',
			...over
		});
		if (r.status !== 201) throw new Error(JSON.stringify(r.body));
		return r.body;
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
	return {
		db,
		project, // added by projects
		app, // added by projects
		call,
		req,
		admin,
		plain,
		mkPart,
		as: (u: typeof admin | Actor) => {
			who = 'kind' in u ? u : asUser(u);
		},
		/** Baseline `id` and return the body. */
		baseline: async (id: number) => {
			const r = await call('POST', `/requirements/${id}/baseline`);
			if (r.status !== 200) throw new Error(JSON.stringify(r.body));
			return r.body;
		}
	};
}
