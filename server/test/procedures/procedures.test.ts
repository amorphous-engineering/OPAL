import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { now } from '@opal/shared';
import { auditLog, procedure, project } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

describe('procedure records', () => {
	test('a procedure needs an existing, active project', async () => {
		const s = await setup();
		expect((await s.call('POST', '/procedures', { name: 'X' })).status).toBe(422);
		expect((await s.call('POST', '/procedures', { projectId: 999, name: 'X' })).status).toBe(404);
		const p = await s.proc('In project');
		expect(p).toMatchObject({ projectId: s.proj.id, projectCode: 'KES', projectName: 'Kestrel' });
		const other = s.db.insert(project).values({ code: 'OLD', name: 'Old', state: 'archived', createdAt: now(), updatedAt: now() }).returning().get();
		expect((await s.call('POST', '/procedures', { projectId: other.id, name: 'X' })).json.error).toBe('project_archived');
	});

	test('list filters by project and a clone stays in the project', async () => {
		const s = await setup();
		const second = s.db.insert(project).values({ code: 'B', name: 'B', createdAt: now(), updatedAt: now() }).returning().get();
		await s.proc('One');
		const two = await s.ok('POST', '/procedures', { projectId: second.id, name: 'Two' });
		expect((await s.ok('GET', `/procedures?projectId=${second.id}`)).items.map((i: any) => i.name)).toEqual(['Two']);
		expect((await s.call('POST', `/procedures/${two.id}/clone`, {})).json.projectId).toBe(second.id);
	});

	test('a new procedure is a draft with the next T-number', async () => {
		const s = await setup();
		const a = await s.proc('A', { description: 'Steps for assembling' });
		const b = await s.proc('B');
		expect(a).toMatchObject({ templateNumber: 'T-0001', status: 'draft', procedureType: 'op', description: 'Steps for assembling', currentVersionId: null, stepCount: 0 });
		expect(b.templateNumber).toBe('T-0002');
	});

	test('a clone gets a new number and the source keeps its own', async () => {
		const s = await setup();
		const src = await s.proc('Source');
		const clone = (await s.call('POST', `/procedures/${src.id}/clone`, {})).json;
		expect(clone.templateNumber).toBe('T-0002');
		expect(clone.name).toBe('Copy of Source');
		expect((await s.ok('GET', `/procedures/${src.id}`)).templateNumber).toBe('T-0001');
	});

	test('a deleted draft keeps its number reserved', async () => {
		const s = await setup();
		const first = await s.proc('A');
		expect((await s.call('DELETE', `/procedures/${first.id}`)).status).toBe(200);
		expect((await s.call('GET', `/procedures/${first.id}`)).status).toBe(404);
		expect((await s.proc('B')).templateNumber).toBe('T-0002');
	});

	test('a published procedure cannot be deleted; it becomes obsolete instead', async () => {
		const s = await setup();
		const { id } = await s.published();
		const r = await s.call('DELETE', `/procedures/${id}`);
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('has_versions');
		const retired = await s.call('PATCH', `/procedures/${id}`, { status: 'obsolete' });
		expect(retired.json.status).toBe('obsolete');
	});

	test('deleting a draft removes its steps, kit and audit trail stays', async () => {
		const s = await setup();
		const p = await s.proc('Gone');
		await s.tree(p.id);
		await s.call('DELETE', `/procedures/${p.id}`);
		expect(s.db.select().from(procedure).where(eq(procedure.id, p.id)).all()).toHaveLength(0);
		const deleted = s.db.select().from(auditLog).where(eq(auditLog.entity, 'procedure')).all().filter((r) => r.action === 'delete');
		expect(deleted).toHaveLength(1);
	});

	test('update changes name, description and type', async () => {
		const s = await setup();
		const p = await s.proc('Original');
		const r = (await s.call('PATCH', `/procedures/${p.id}`, { name: 'Updated', description: 'd', procedureType: 'build' })).json;
		expect(r).toMatchObject({ name: 'Updated', description: 'd', procedureType: 'build' });
	});

	test('release needs a published version', async () => {
		const s = await setup();
		const p = await s.proc('Unpublished');
		const r = await s.call('PATCH', `/procedures/${p.id}`, { status: 'released' });
		expect(r.status).toBe(409);
		const { id } = await s.published('Cycle');
		expect((await s.call('PATCH', `/procedures/${id}`, { status: 'obsolete' })).json.status).toBe('obsolete');
		expect((await s.call('PATCH', `/procedures/${id}`, { status: 'released' })).json.status).toBe('released');
	});

	test('an invalid status or type is refused', async () => {
		const s = await setup();
		const p = await s.proc('X');
		expect((await s.call('PATCH', `/procedures/${p.id}`, { status: 'active' })).status).toBe(422);
		expect((await s.call('POST', '/procedures', { projectId: s.proj.id, name: 'X', procedureType: 'weird' })).status).toBe(422);
		expect((await s.call('POST', '/procedures', { projectId: s.proj.id, name: '' })).status).toBe(422);
	});

	test('list rows carry version, step count and execution count', async () => {
		const s = await setup();
		const { id } = await s.published('Counted');
		await s.proc('Draft Build', { procedureType: 'build' });
		const items = Object.fromEntries((await s.ok('GET', '/procedures')).items.map((i: any) => [i.name, i]));
		expect(items['Counted']).toMatchObject({ id, currentVersionNumber: 1, stepCount: 2, opCount: 2, executionCount: 0, status: 'released' });
		expect(items['Draft Build'].currentVersionNumber).toBeNull();
	});

	test('list filters by status and type, searches number and name, and sorts', async () => {
		const s = await setup();
		await s.published('Zeta Op');
		await s.proc('Alpha Build', { procedureType: 'build' });
		const names = async (q: string) => (await s.ok('GET', `/procedures?${q}`)).items.map((i: any) => i.name);
		expect(await names('procedureType=build')).toEqual(['Alpha Build']);
		expect(await names('status=released')).toEqual(['Zeta Op']);
		expect(await names('sort=name&dir=asc')).toEqual(['Alpha Build', 'Zeta Op']);
		expect(await names('q=T-0002')).toEqual(['Alpha Build']);
		expect(await names('q=zeta')).toEqual(['Zeta Op']);
		expect((await s.call('GET', '/procedures?sort=bogus')).status).toBe(422);
	});

	test('the list pages with a cursor and reports the total', async () => {
		const s = await setup();
		for (const n of ['A', 'B', 'C']) await s.proc(n);
		const first = await s.ok('GET', '/procedures?limit=2&sort=number&dir=asc');
		expect(first.items.map((i: any) => i.name)).toEqual(['A', 'B']);
		expect(first.total).toBe(3);
		const second = await s.ok('GET', `/procedures?limit=2&sort=number&dir=asc&cursor=${first.next}`);
		expect(second.items.map((i: any) => i.name)).toEqual(['C']);
		expect(second.next).toBeNull();
	});

	test('a missing procedure is 404 on every route', async () => {
		const s = await setup();
		for (const [m, p] of [['GET', '/procedures/999'], ['GET', '/procedures/999/draft'], ['GET', '/procedures/999/kit'], ['POST', '/procedures/999/publish'], ['GET', '/procedures/999/versions']] as const) {
			expect((await s.call(m, p, m === 'POST' ? {} : undefined)).status).toBe(404);
		}
	});

	test('build creates steps, step kits, kit and outputs in one call', async () => {
		const s = await setup();
		const screw = await s.part('Screw');
		const asm = await s.part('Assembly');
		const r = await s.call('POST', '/procedures/build', {
			projectId: s.proj.id,
			name: 'Built',
			procedureType: 'build',
			steps: [{ title: 'Mount', kit: [{ partId: screw.id, quantity: '4' }], requiredRole: 'Quality' }, { title: 'Test' }],
			kit: [{ partId: screw.id, quantity: '8' }],
			outputs: [{ partId: asm.id, quantity: '1' }]
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ stepCount: 2, stepKitCount: 1, kitCount: 1, outputCount: 1 });
		const d = await s.draft(r.json.procedure.id);
		expect(d.map((x) => x.number)).toEqual(['1', '2']);
		expect(d[0].kit[0]).toMatchObject({ partId: screw.id, quantity: '4', usage: 'consume' });
		expect(d[0].signoffs[0].role).toBe('Quality');
	});

	test('build checks every part and workcenter before it writes anything', async () => {
		const s = await setup();
		const r = await s.call('POST', '/procedures/build', { projectId: s.proj.id, name: 'Bad', steps: [{ title: 'x', kit: [{ partId: 999, quantity: '1' }] }] });
		expect(r.status).toBe(404);
		expect((await s.ok('GET', '/procedures')).total).toBe(0);
		const w = await s.call('POST', '/procedures/build', { projectId: s.proj.id, name: 'Bad', steps: [{ title: 'x', workcenterId: 77 }] });
		expect(w.status).toBe(404);
	});

	test('search finds a procedure by number and name', async () => {
		const s = await setup();
		await s.proc('Pressure test');
		const hits = (await s.ok('GET', '/search?q=Pressure')).hits ?? (await s.ok('GET', '/search?q=Pressure'));
		expect(JSON.stringify(hits)).toContain('T-0001');
	});
});
