import { describe, expect, test } from 'bun:test';
import { setup } from '../execution/helpers.ts';

async function withRoles() {
	const s = await setup();
	const director = await s.ok('POST', '/roles', { name: 'Launch Director' });
	const operator = await s.ok('POST', '/roles', { name: 'Launch Operator', code: 'lo', color: 'teal' });
	return { ...s, director, operator };
}

describe('role marks', () => {
	test('a role has a mark: the initials of its name until someone sets the letters', async () => {
		const s = await withRoles();
		expect(s.director.code).toBe('LD');
		expect(s.operator).toMatchObject({ code: 'LO', color: 'teal' });
		const tech = (await s.ok('GET', '/roles')).find((r: any) => r.name === 'Technician');
		expect(tech.code).toBe('TE');
		const set = await s.ok('PATCH', `/roles/${s.director.id}`, { code: 'dir', color: 'purple' });
		expect(set).toMatchObject({ code: 'DIR', color: 'purple' });
		expect((await s.call('PATCH', `/roles/${s.director.id}`, { code: 'LDXX' })).status).toBe(422);
		expect((await s.call('PATCH', `/roles/${s.director.id}`, { color: 'red' })).status).toBe(422);
	});

	test('a step names the role that does it and shows its mark', async () => {
		const s = await withRoles();
		const p = await s.proc('Load and Go');
		const op = await s.step(p.id, 'Load and Go');
		const st = await s.step(p.id, 'Flip the FILL switch UP', { parentId: op.id, performer: 'launch operator' });
		expect(st.performer).toEqual({ name: 'Launch Operator', code: 'LO', color: 'teal' });
		const cleared = await s.ok('PATCH', `/procedures/${p.id}/steps/${st.id}`, { performer: null });
		expect(cleared.performer).toBeNull();
		const r = await s.call('PATCH', `/procedures/${p.id}/steps/${st.id}`, { performer: 'Pad Chief' });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('unknown_role');
	});

	test('a performer gates nothing: anyone completes the step, and it needs no sign-off', async () => {
		const s = await withRoles();
		const p = await s.proc('Load and Go');
		const op = await s.step(p.id, 'Load and Go');
		const st = await s.step(p.id, 'Call fill complete', { parentId: op.id, performer: 'Launch Director' });
		expect(st).toMatchObject({ requiresSignoff: false, requiredRole: null });
		expect(st.signoffs).toEqual([{ label: 'Primary buyoff', role: null }]);
		await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const wo = await s.cut(p.id);
		const r = await s.complete(wo.id, '1.1', {}, s.benActor);
		expect(r.status).toBe(200);
	});

	test('a published version keeps the mark it was published with', async () => {
		const s = await withRoles();
		const p = await s.proc('Load and Go');
		const op = await s.step(p.id, 'Load and Go');
		await s.step(p.id, 'Note fill start time', { parentId: op.id, performer: 'Launch Director' });
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const frozen = { name: 'Launch Director', code: 'LD', color: s.director.color };

		await s.ok('PATCH', `/roles/${s.director.id}`, { code: 'DR', color: 'magenta' });
		// A recoloured role is not a change to the procedure.
		expect((await s.ok('GET', `/procedures/${p.id}`)).unpublishedChanges).toBe(false);
		expect((await s.draft(p.id))[1].performer).toEqual({ name: 'Launch Director', code: 'DR', color: 'magenta' });

		await s.ok('DELETE', `/roles/${s.director.id}`);
		// The draft still says who, without a colour, until an author picks a role that exists.
		expect((await s.draft(p.id))[1].performer).toEqual({ name: 'Launch Director', code: 'LD', color: null });

		const detail = await s.ok('GET', `/procedures/versions/${v.id}`);
		expect(detail.snapshot.steps[1].performer).toEqual(frozen);
		expect(detail.snapshot.steps[0].performer).toBeUndefined();
		const wo = await s.cut(p.id);
		const doc = await s.doc(wo.id);
		const step = doc.ops[0].steps.find((x: any) => x.number === '1.1');
		expect(step.performer).toEqual(frozen);
		expect(doc.ops[0].performer).toBeNull();
	});

	test('the diff reports a change of performer by role name', async () => {
		const s = await withRoles();
		const p = await s.proc('Load and Go');
		const op = await s.step(p.id, 'Load and Go');
		const st = await s.step(p.id, 'Launch or dump', { parentId: op.id, performer: 'Launch Director' });
		const v1 = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		await s.ok('PATCH', `/procedures/${p.id}/steps/${st.id}`, { performer: 'Launch Operator' });
		expect((await s.ok('GET', `/procedures/${p.id}`)).unpublishedChanges).toBe(true);
		const v2 = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		const d = await s.ok('GET', `/procedures/${p.id}/versions/${v1.id}/diff/${v2.id}`);
		const changed = d.steps.find((x: any) => x.number === '1.1');
		expect(changed.changedFields).toEqual(['performer']);
		expect(changed.changes.performer).toEqual({ a: 'Launch Director', b: 'Launch Operator' });
	});

	test('duplicate, copy and restore keep the performer', async () => {
		const s = await withRoles();
		const p = await s.proc('Load and Go');
		const op = await s.step(p.id, 'Load and Go');
		const st = await s.step(p.id, 'Switches down', { parentId: op.id, performer: 'Launch Operator' });
		const dup = await s.ok('POST', `/procedures/${p.id}/steps/${st.id}/duplicate`, {});
		expect(dup.performer?.name).toBe('Launch Operator');
		const v = await s.ok('POST', `/procedures/${p.id}/publish`, {});
		await s.ok('PATCH', `/procedures/${p.id}/steps/${st.id}`, { performer: null });
		await s.ok('POST', `/procedures/${p.id}/versions/${v.id}/restore`);
		expect((await s.draft(p.id)).find((x) => x.id === st.id).performer?.name).toBe('Launch Operator');
	});
});

describe('project roles', () => {
	async function twoProjects() {
		const s = await setup();
		const other = await s.ok('POST', '/projects', { code: 'OTH', name: 'Other' });
		const director = await s.ok('POST', '/roles', { name: 'Launch Director', projectId: s.proj.id });
		return { ...s, other, director };
	}

	test('a project role is offered in its own project only', async () => {
		const s = await twoProjects();
		expect(s.director.projectId).toBe(s.proj.id);
		const mine = await s.proc('Load and Go');
		const op = await s.step(mine.id, 'Load and Go', { performer: 'Launch Director', signoffs: [{ role: 'Launch Director' }] });
		expect(op.performer.name).toBe('Launch Director');

		const theirs = await s.ok('POST', '/procedures', { projectId: s.other.id, name: 'Elsewhere' });
		const r = await s.call('POST', `/procedures/${theirs.id}/steps`, { title: 'Count down', performer: 'Launch Director' });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('role_not_in_project');
		const st = await s.step(theirs.id, 'Count down');
		const slot = await s.call('PATCH', `/procedures/${theirs.id}/steps/${st.id}`, { requiredRole: 'Launch Director' });
		expect(slot.json.error).toBe('role_not_in_project');
		// Organization roles go anywhere.
		expect((await s.step(theirs.id, 'Inspect', { performer: 'Quality' })).performer.name).toBe('Quality');
	});

	test('a procedure cannot move to a project that does not offer its roles', async () => {
		const s = await twoProjects();
		const p = await s.proc('Load and Go');
		await s.step(p.id, 'Load and Go', { performer: 'Launch Director' });
		const r = await s.call('PATCH', `/procedures/${p.id}`, { projectId: s.other.id });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('role_not_in_project');
	});

	test('a project role passes no gate', async () => {
		const s = await twoProjects();
		const r = await s.call('PUT', '/gates/issue.approve', { roleIds: [s.director.id] });
		expect(r.status).toBe(400);
		expect(r.json.error).toBe('project_role');
	});

	test('names stay unique across the organization, and colours run per project', async () => {
		const s = await twoProjects();
		expect((await s.call('POST', '/roles', { name: 'quality', projectId: s.proj.id })).status).toBe(409);
		expect((await s.call('POST', '/roles', { name: 'Launch Director', projectId: s.other.id })).status).toBe(409);
		const operator = await s.ok('POST', '/roles', { name: 'Launch Operator', projectId: s.proj.id });
		// The first two roles of the project take the first two colours, whatever the organization has.
		expect([s.director.color, operator.color]).toEqual(['purple', 'teal']);
	});
});
