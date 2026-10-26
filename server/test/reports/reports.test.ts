import { describe, expect, test } from 'bun:test';
import { parseQty } from '@opal/shared';
import { project, user } from '../../src/db/schema/index.ts';
import { createApp } from '../../src/app.ts';
import { update } from '../../src/write.ts';
import { makePart, setup as baseSetup } from '../inventory/helpers.ts';
import { orderedPo } from '../purchasing/helpers.ts';
import { receiveStock } from '../../src/services/inventory/index.ts';
import { registerExecutionReport } from '../../src/services/reports/exports.ts';
import { registerOverviewSection } from '../../src/services/reports/overview.ts';
import { toCsv } from '../../src/services/reports/csv.ts';
import { reportsImpls } from '../../src/ops/reports.ts';

/** The base setup, with one project; issue and risk creates carry its id. */
async function setup() {
	const s = await baseSetup();
	const ts = new Date().toISOString();
	const proj = s.db.insert(project).values({ code: 'P1', name: 'Project', createdAt: ts, updatedAt: ts }).returning().get();
	const call = (method: string, path: string, body?: unknown) =>
		s.call(method, path, method === 'POST' && (path === '/issues' || path === '/risks') ? { projectId: proj.id, ...(body as object) } : body);
	return { ...s, call, project: proj };
}

const text = async (s: Awaited<ReturnType<typeof setup>>, path: string) => {
	const res = await s.app.request(`/api${path}`);
	return { res, body: await res.text() };
};

describe('csv text', () => {
	test('quotes cells that need it and neutralizes formulas but not numbers', () => {
		const out = toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['=1+1', '-5'], [null, 3]]);
		expect(out).toBe('a,b\r\n"x,y","say ""hi"""\r\n\'=1+1,-5\r\n,3\r\n');
	});
});

describe('overview', () => {
	test('the activity feed hides another user admin-only fields from a non-admin', async () => {
		const s = await baseSetup();
		update(s.ctx, user, s.admin.id, { email: 'private@x.test' });
		expect(JSON.stringify((await s.call('GET', '/overview')).body.activity)).toContain('private@x.test');
		const app = createApp({ db: s.db, resolveActor: () => ({ kind: 'user', userId: 9999, isAdmin: false, sessionId: 1 }) });
		const res = await app.request('/api/overview');
		expect(JSON.stringify(await res.json())).not.toContain('private@x.test');
	});

	test('issue counts, mine first, and holding issues', async () => {
		const s = await setup();
		await s.call('POST', '/issues', { title: 'Low one', priority: 'low' });
		await s.call('POST', '/issues', { title: 'Critical one', priority: 'critical' });
		await s.call('POST', '/issues', { title: 'Mine', priority: 'low', assignedToId: s.admin.id });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.issues.counts).toMatchObject({ open: 3, critical: 1, low: 2, unassigned: 2, mine: 1 });
		expect(o.issues.items[0].title).toBe('Mine');
		expect(o.issues.items[1].title).toBe('Critical one');
		expect(o.issues.items[0].mine).toBe(true);
	});

	test('lists are capped at 8 and total says how many exist', async () => {
		const s = await setup();
		for (let i = 0; i < 10; i++) await s.call('POST', '/issues', { title: `I${i}` });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.issues.items.length).toBe(8);
		expect(o.issues.total).toBe(10);
	});

	test('low stock lists the part furthest below its reorder point first', async () => {
		const s = await setup();
		const a = makePart(s.db, { reorderPoint: parseQty('10') });
		const b = makePart(s.db, { reorderPoint: parseQty('10') });
		receiveStock(s.ctx, { partId: a.id, quantity: parseQty('9'), location: 'A' });
		receiveStock(s.ctx, { partId: b.id, quantity: parseQty('2'), location: 'A' });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.lowStock.total).toBe(2);
		expect(o.lowStock.items.map((r: { partNumber: string }) => r.partNumber)).toEqual([b.internalPn, a.internalPn]);
		expect(o.lowStock.items[0]).toMatchObject({ onHand: '2', reorderPoint: '10', href: `/parts/${b.id}` });
	});

	test('purchases awaiting receipt are counted, overdue ones are flagged', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await orderedPo(s, p.id, '3', { targetDate: '2020-01-01' });
		await orderedPo(s, p.id, '3', { targetDate: '2999-01-01' });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.purchases).toMatchObject({ total: 2, flagged: 1 });
		expect(o.purchases.items[0]).toMatchObject({ overdue: true, linesOpen: 1 });
	});

	test('expired stock and overdue calibration need attention; stock expiring later is not flagged', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const tool = makePart(s.db, { isTooling: true });
		const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('1'), location: 'A', expirationDate: '2020-01-01' });
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('1'), location: 'A', expirationDate: soon });
		const [t] = receiveStock(s.ctx, { partId: tool.id, quantity: parseQty('1'), location: 'A' });
		await s.call('PATCH', `/inventory/${t!.id}`, { calibrationDueAt: '2020-01-01T00:00:00.000Z' });
		const o = (await s.call('GET', '/overview')).body;
		const kinds = o.stockAttention.items.map((r: { kind: string }) => r.kind).sort();
		expect(kinds.filter((k: string) => k === 'expired').length).toBe(1);
		expect(kinds.filter((k: string) => k === 'expiring').length).toBe(1);
		expect(o.stockAttention.flagged).toBe(o.stockAttention.total - 1);
	});

	test('only open risks with a score above 12 are high', async () => {
		const s = await setup();
		await s.call('POST', '/risks', { title: 'High', assetText: 'rig', probability: 5, impact: 4 });
		await s.call('POST', '/risks', { title: 'Mid', assetText: 'rig', probability: 3, impact: 4 });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.risks.total).toBe(1);
		expect(o.risks.items[0]).toMatchObject({ title: 'High', score: 20 });
	});

	test('the execution area adds its section through the hook', async () => {
		const s = await setup();
		registerOverviewSection('executions', () => ({
			items: [{ label: 'WO-1', procedure: 'P', status: 'in_work', stepsDone: 1, stepsTotal: 2, blocked: false, overdue: false, targetCompletionAt: null, mine: true, href: '/executions/1' }],
			total: 1,
			flagged: 0
		}));
		const o = (await s.call('GET', '/overview')).body;
		expect(o.executions.items[0].label).toBe('WO-1');
		registerOverviewSection('executions', () => ({ items: [], total: 0, flagged: 0 }));
	});

	test('recent activity lists the newest audit entries', async () => {
		const s = await setup();
		await s.call('POST', '/issues', { title: 'Audited' });
		const o = (await s.call('GET', '/overview')).body;
		expect(o.activity.length).toBeGreaterThan(0);
	});
});

describe('project filter', () => {
	test('the overview, the issue csv and the issue metrics narrow to one project', async () => {
		const s = await setup();
		const ts = new Date().toISOString();
		const other = s.db.insert(project).values({ code: 'P2', name: 'Other', createdAt: ts, updatedAt: ts }).returning().get();
		await s.call('POST', '/issues', { title: 'In first' });
		await s.call('POST', '/issues', { title: 'In second', projectId: other.id });
		const o = (await s.call('GET', `/overview?projectId=${other.id}`)).body;
		expect(o.issues.items.map((i: { title: string }) => i.title)).toEqual(['In second']);
		expect((await s.call('GET', '/overview')).body.issues.total).toBe(2);
		const csv = (await text(s, `/reports/issues/csv?projectId=${other.id}`)).body;
		expect(csv).toContain('In second');
		expect(csv).not.toContain('In first');
		expect((await s.call('GET', `/reports/analytics/issues?projectId=${other.id}`)).body.totalIssues).toBe(1);
	});
});

describe('csv reports', () => {
	test('parts csv carries on-hand and locations and filters by category', async () => {
		const s = await setup();
		const p = makePart(s.db);
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('4'), location: 'Shelf 1' });
		const { res, body } = await text(s, '/reports/parts/csv');
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(res.headers.get('content-disposition')).toContain('attachment');
		expect(body).toContain(`${p.internalPn},,${p.name},,,ea,buy,active,4,Shelf 1`);
		expect((await text(s, '/reports/parts/csv?category=none')).body.trim().split('\r\n').length).toBe(1);
	});

	test('parts csv with lowStock keeps only parts below the reorder point', async () => {
		const s = await setup();
		const low = makePart(s.db, { reorderPoint: parseQty('5') });
		const fine = makePart(s.db, { reorderPoint: parseQty('5') });
		receiveStock(s.ctx, { partId: fine.id, quantity: parseQty('9'), location: 'A' });
		const body = (await text(s, '/reports/parts/csv?lowStock=true')).body;
		expect(body).toContain(low.internalPn);
		expect(body).not.toContain(fine.internalPn);
	});

	test('inventory csv filters by location substring', async () => {
		const s = await setup();
		const p = makePart(s.db);
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('1'), location: 'Bin A' });
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('1'), location: 'Cage' });
		const body = (await text(s, '/reports/inventory/csv?location=bin')).body;
		expect(body).toContain('Bin A');
		expect(body).not.toContain('Cage');
	});

	test('issues csv filters by priority', async () => {
		const s = await setup();
		await s.call('POST', '/issues', { title: 'Hot', priority: 'critical' });
		await s.call('POST', '/issues', { title: 'Cold', priority: 'low' });
		const body = (await text(s, '/reports/issues/csv?priority=critical')).body;
		expect(body).toContain('Hot');
		expect(body).not.toContain('Cold');
	});

	test('risks csv skips risks below the minimum score', async () => {
		const s = await setup();
		await s.call('POST', '/risks', { title: 'Big', assetText: 'rig', probability: 5, impact: 5 });
		await s.call('POST', '/risks', { title: 'Small', assetText: 'rig', probability: 1, impact: 1 });
		const body = (await text(s, '/reports/risks/csv?minScore=10')).body;
		expect(body).toContain('Big');
		expect(body).not.toContain('Small');
	});

	test('executions csv and metrics come from the rows the execution area registers', async () => {
		const s = await setup();
		const row = (id: number, status: string, started: string | null, done: string | null) => ({
			id, procedure: 'P', version: 1, workOrder: `WO-${id}`, status, priority: null,
			createdAt: '2026-01-01T00:00:00.000Z', startedAt: started, completedAt: done, stepsCompleted: 1, stepsTotal: 2
		});
		registerExecutionReport(() => [
			row(1, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
			row(2, 'in_work', '2026-01-01T00:00:00.000Z', null),
			row(3, 'cut', null, null)
		]);
		const csv = (await text(s, '/reports/executions/csv')).body;
		expect(csv).toContain('WO-1,completed,2026-01-01T00:00:00.000Z,2026-01-01T00:00:00.000Z,2026-01-01T01:00:00.000Z,60,1,2');
		const m = (await s.call('GET', '/reports/analytics/executions')).body;
		expect(m).toEqual({ totalExecutions: 3, completed: 1, inWork: 1, cut: 1, aborted: 0, avgDurationMinutes: 60, completionRate: 33.3 });
		const none = (await s.call('GET', '/reports/analytics/executions?to=2025-01-01')).body;
		expect(none.totalExecutions).toBe(0);
		expect(none.avgDurationMinutes).toBeNull();
		registerExecutionReport(() => []);
	});

	test('issue metrics: open splits into advisory, undispositioned and dispositioned', async () => {
		const s = await setup();
		await s.call('POST', '/issues', { title: 'A', issueType: 'bug', priority: 'high' });
		await s.call('POST', '/issues', { title: 'B', issueType: 'task', priority: 'high' });
		const m = (await s.call('GET', '/reports/analytics/issues')).body;
		expect(m).toMatchObject({ totalIssues: 2, open: 2, advisoryOpen: 2, closed: 0 });
		expect(m.byType).toEqual({ bug: 1, task: 1 });
		expect(m.byPriority).toEqual({ high: 2 });
		expect(m.advisoryOpen + m.undispositioned + m.dispositioned).toBe(m.open);
	});
});

test('every report operation is bound', () => {
	expect(reportsImpls.length).toBe(13);
});
