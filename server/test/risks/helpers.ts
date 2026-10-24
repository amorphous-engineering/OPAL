import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { part, user } from '../../src/db/schema/index.ts';
import { openTestDb } from '../helpers/db.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects

// Importing the ops registers the risks hook on the issues area.
import '../../src/ops/risks.ts';

export async function setup() {
	const db = await openTestDb();
	const ts = now();
	const mkUser = (username: string, isAdmin = true) =>
		db
			.insert(user)
			.values({ username, name: username.toUpperCase(), isAdmin, createdAt: ts, updatedAt: ts })
			.returning()
			.get();
	const admin = mkUser('abby');
	const other = mkUser('ben');
	const asUser = (u: { id: number; isAdmin: boolean }): Actor => ({
		kind: 'user',
		userId: u.id,
		isAdmin: u.isAdmin,
		sessionId: 1
	});
	let who: Actor = asUser(admin);
	const app = createApp({ db, resolveActor: () => who });
	const project = createTestProject(db); // added by projects
	const scoped = new Set(['/risks', '/issues']); // added by projects: creates that need a project
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
	const COMPLETE = {
		title: 'Valve leak',
		condition: 'The valve seat is scored',
		departure: 'Helium leaks past the seat during fill',
		assetText: 'test campaign',
		consequence: 'Loss of two test days',
		ownerId: admin.id
	};
	const mk = async (body: Record<string, unknown> = {}) => {
		const r = await call('POST', '/risks', { ...COMPLETE, ...body });
		if (r.status !== 201) throw new Error(JSON.stringify(r.body));
		return r.body;
	};
	const mkIssue = async (title = 'Fix it') => {
		const r = await call('POST', '/issues', { title });
		if (r.status !== 201) throw new Error(JSON.stringify(r.body));
		return r.body;
	};
	return {
		db,
		project, // added by projects
		app, // added by projects
		call,
		admin,
		other,
		mkPart,
		mk,
		mkIssue,
		COMPLETE,
		as: (u: { id: number; isAdmin: boolean } | Actor) => {
			who = 'kind' in u ? u : asUser(u);
		}
	};
}
