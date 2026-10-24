import { describe, expect, test } from 'bun:test';
import { auditLog } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function fx() {
	const s = await setup();
	const p = await s.proc('Authoring');
	return { ...s, pid: p.id as number };
}

describe('step tree', () => {
	test('the draft is in document order with derived numbers and orders', async () => {
		const s = await fx();
		await s.tree(s.pid);
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP one'], ['1.1', 'a'], ['1.2', 'b'], ['2', 'OP two'], ['2.1', 'c']]);
		expect((await s.draft(s.pid)).map((x) => [x.order, x.level])).toEqual([[1, 0], [2, 1], [3, 1], [4, 0], [5, 1]]);
	});

	test('contingency OPs are numbered C1, C2 apart from the normal OPs', async () => {
		const s = await fx();
		await s.step(s.pid, 'Normal');
		const c1 = await s.step(s.pid, 'Fallback', { isContingency: true });
		await s.step(s.pid, 'Sub', { parentId: c1.id });
		await s.step(s.pid, 'Normal 2');
		expect(await s.numbers(s.pid)).toEqual([['1', 'Normal'], ['2', 'Normal 2'], ['C1', 'Fallback'], ['C1.1', 'Sub']]);
	});

	test('a sub-step follows its OP in contingency and cannot hold sub-steps', async () => {
		const s = await fx();
		const c = await s.step(s.pid, 'C', { isContingency: true });
		const sub = await s.step(s.pid, 'sub', { parentId: c.id, isContingency: false });
		expect(sub.isContingency).toBe(true);
		const r = await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'deep', parentId: sub.id });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('nesting_too_deep');
	});

	test('insert after a sub-step lands in the same OP', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		await s.step(s.pid, 'a2', { parentId: a.parentId, afterStepId: a.id });
		expect((await s.numbers(s.pid)).map((x) => x[0])).toEqual(['1', '1.1', '1.2', '1.3', '2', '2.1']);
		expect((await s.numbers(s.pid))[2]).toEqual(['1.2', 'a2']);
	});

	test('insert after an OP becomes its first sub-step or the next OP', async () => {
		const s = await fx();
		const { op1 } = await s.tree(s.pid);
		await s.step(s.pid, 'first', { parentId: op1.id, afterStepId: op1.id });
		await s.step(s.pid, 'between', { afterStepId: op1.id });
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP one'], ['1.1', 'first'], ['1.2', 'a'], ['1.3', 'b'], ['2', 'between'], ['3', 'OP two'], ['3.1', 'c']]);
	});

	test('insert after an unknown step is 404', async () => {
		const s = await fx();
		expect((await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'x', afterStepId: 99999 })).status).toBe(404);
	});

	test('a step of another procedure is not found', async () => {
		const s = await fx();
		const other = await s.proc('Other');
		const foreign = await s.step(other.id, 'Foreign');
		expect((await s.call('PATCH', `/procedures/${s.pid}/steps/${foreign.id}`, { title: 'x' })).status).toBe(404);
		expect((await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'x', parentId: foreign.id })).status).toBe(404);
	});

	test('deleting an OP drops its sub-steps and renumbers', async () => {
		const s = await fx();
		const { op1 } = await s.tree(s.pid);
		expect((await s.call('DELETE', `/procedures/${s.pid}/steps/${op1.id}`)).status).toBe(200);
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP two'], ['1.1', 'c']]);
		expect((await s.draft(s.pid)).map((x) => x.order)).toEqual([1, 2]);
	});

	test('deleting a sub-step renumbers its siblings', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		await s.call('DELETE', `/procedures/${s.pid}/steps/${a.id}`);
		expect((await s.numbers(s.pid)).slice(0, 2)).toEqual([['1', 'OP one'], ['1.1', 'b']]);
	});

	test('move a sub-step within its OP', async () => {
		const s = await fx();
		const { op1, b } = await s.tree(s.pid);
		const r = await s.call('POST', `/procedures/${s.pid}/steps/${b.id}/move`, { parentId: op1.id, index: 0 });
		expect(r.status).toBe(200);
		expect((await s.numbers(s.pid)).slice(0, 3)).toEqual([['1', 'OP one'], ['1.1', 'b'], ['1.2', 'a']]);
	});

	test('move a sub-step to another OP', async () => {
		const s = await fx();
		const { op2, a } = await s.tree(s.pid);
		await s.call('POST', `/procedures/${s.pid}/steps/${a.id}/move`, { parentId: op2.id, index: 1 });
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP one'], ['1.1', 'b'], ['2', 'OP two'], ['2.1', 'c'], ['2.2', 'a']]);
	});

	test('move an OP down', async () => {
		const s = await fx();
		const { op1 } = await s.tree(s.pid);
		await s.call('POST', `/procedures/${s.pid}/steps/${op1.id}/move`, { parentId: null, index: 1 });
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP two'], ['1.1', 'c'], ['2', 'OP one'], ['2.1', 'a'], ['2.2', 'b']]);
	});

	test('an OP with sub-steps cannot move under another OP', async () => {
		const s = await fx();
		const { op1, op2 } = await s.tree(s.pid);
		const r = await s.call('POST', `/procedures/${s.pid}/steps/${op1.id}/move`, { parentId: op2.id, index: 0 });
		expect(r.status).toBe(422);
		expect(r.json.error).toBe('op_has_substeps');
	});

	test('a step cannot move into itself or under a sub-step', async () => {
		const s = await fx();
		const { op1, a } = await s.tree(s.pid);
		const leaf = await s.step(s.pid, 'leaf');
		expect((await s.call('POST', `/procedures/${s.pid}/steps/${leaf.id}/move`, { parentId: leaf.id, index: 0 })).json.error).toBe('move_into_self');
		expect((await s.call('POST', `/procedures/${s.pid}/steps/${leaf.id}/move`, { parentId: a.id, index: 0 })).json.error).toBe('nesting_too_deep');
		expect(op1.id).toBeGreaterThan(0);
	});

	test('demoting a leaf OP drops its dependencies and sequence flag', async () => {
		const s = await fx();
		const { op1, op2 } = await s.tree(s.pid);
		const leaf = await s.step(s.pid, 'leaf', { strictSequence: true });
		await s.ok('PUT', `/procedures/${s.pid}/steps/${leaf.id}/dependencies`, { dependsOn: [op1.id] });
		const r = (await s.call('POST', `/procedures/${s.pid}/steps/${leaf.id}/move`, { parentId: op2.id, index: 0 })).json;
		expect(r).toMatchObject({ number: '2.1', level: 1, dependsOn: [], strictSequence: false });
	});

	test('promoting a sub-step makes it an OP', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		await s.call('POST', `/procedures/${s.pid}/steps/${a.id}/move`, { parentId: null, index: 1 });
		expect((await s.numbers(s.pid)).slice(0, 4)).toEqual([['1', 'OP one'], ['1.1', 'b'], ['2', 'a'], ['3', 'OP two']]);
	});

	test('toggling contingency moves an OP to the C group and renumbers', async () => {
		const s = await fx();
		const { op1 } = await s.tree(s.pid);
		const r = await s.call('PATCH', `/procedures/${s.pid}/steps/${op1.id}`, { isContingency: true });
		expect(r.status).toBe(200);
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP two'], ['1.1', 'c'], ['C1', 'OP one'], ['C1.1', 'a'], ['C1.2', 'b']]);
		expect((await s.draft(s.pid)).slice(2).every((x) => x.isContingency)).toBe(true);
	});

	test('contingency cannot be set on a sub-step', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		const r = await s.call('PATCH', `/procedures/${s.pid}/steps/${a.id}`, { isContingency: true });
		expect(r.status).toBe(422);
	});

	test('duplicating a sub-step copies its content next to it', async () => {
		const s = await fx();
		const { a } = await s.tree(s.pid);
		const nut = await s.part('Nut');
		await s.ok('POST', `/procedures/${s.pid}/steps/${a.id}/kit`, { partId: nut.id, quantity: '2', usage: 'tooling' });
		await s.ok('PATCH', `/procedures/${s.pid}/steps/${a.id}`, {
			dataSchema: { fields: [{ name: 't', type: 'number' }] },
			callouts: [{ kind: 'caution', text: 'hot' }]
		});
		const copy = (await s.call('POST', `/procedures/${s.pid}/steps/${a.id}/duplicate`)).json;
		expect((await s.draft(s.pid)).map((x) => x.number)).toEqual(['1', '1.1', '1.2', '1.3', '2', '2.1']);
		expect(copy).toMatchObject({ number: '1.2', title: 'a', callouts: [{ kind: 'caution', text: 'hot' }] });
		expect(copy.id).not.toBe(a.id);
		expect(copy.kit[0]).toMatchObject({ usage: 'tooling', quantity: '2' });
		expect(copy.dataSchema.fields[0].name).toBe('t');
	});

	test('duplicating an OP takes its sub-steps and not its dependencies', async () => {
		const s = await fx();
		const { op1, op2 } = await s.tree(s.pid);
		await s.ok('PUT', `/procedures/${s.pid}/steps/${op2.id}/dependencies`, { dependsOn: [op1.id] });
		const copy = (await s.call('POST', `/procedures/${s.pid}/steps/${op2.id}/duplicate`)).json;
		expect(copy.dependsOn).toEqual([]);
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP one'], ['1.1', 'a'], ['1.2', 'b'], ['2', 'OP two'], ['2.1', 'c'], ['3', 'OP two'], ['3.1', 'c']]);
	});

	test('a step workcenter round-trips, stays when absent and clears with null', async () => {
		const s = await fx();
		const wc = (await s.ok('POST', '/workcenters', { name: 'Bench', code: 'B1' }));
		const st = await s.step(s.pid, 'with wc', { workcenterId: wc.id });
		expect(st.workcenterId).toBe(wc.id);
		expect((await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { title: 'renamed' })).workcenterId).toBe(wc.id);
		expect((await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { workcenterId: null })).workcenterId).toBeNull();
		expect((await s.call('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { workcenterId: 99999 })).status).toBe(404);
	});

	test('workcenter work lists the steps that default there', async () => {
		const s = await fx();
		const wc = (await s.ok('POST', '/workcenters', { name: 'Bench', code: 'B1' }));
		const { a } = await s.tree(s.pid);
		await s.ok('PATCH', `/procedures/${s.pid}/steps/${a.id}`, { workcenterId: wc.id });
		const work = await s.ok('GET', `/workcenters/${wc.id}/work`);
		expect(work.defaultSteps).toEqual([{ procedureId: s.pid, procedureName: 'Authoring', procedureStatus: 'draft', stepNumber: '1.1', title: 'a' }]);
		expect((await s.ok('GET', `/workcenters/${wc.id}`)).defaultStepCount).toBe(1);
	});

	test('null clears text, duration and schema; absent leaves them', async () => {
		const s = await fx();
		const st = await s.step(s.pid, 'full', { instructions: 'text', estimatedDurationMinutes: 5, dataSchema: { fields: [{ name: 'x', type: 'text' }] } });
		await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { title: 'still full' });
		const kept = (await s.draft(s.pid))[0];
		expect(kept).toMatchObject({ instructions: 'text', estimatedDurationMinutes: 5 });
		const cleared = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { instructions: null, estimatedDurationMinutes: null, dataSchema: null });
		expect(cleared).toMatchObject({ instructions: null, estimatedDurationMinutes: null, dataSchema: null });
	});

	test('a schema with no fields is stored as no schema', async () => {
		const s = await fx();
		const st = await s.step(s.pid, 'x', { dataSchema: { fields: [] } });
		expect(st.dataSchema).toBeNull();
	});

	test('photo fields keep their single or multiple flag', async () => {
		const s = await fx();
		const schema = { fields: [{ name: 'w', label: 'Witness', type: 'photo', required: true, multiple: false }, { name: 'd', type: 'photo', multiple: true }] };
		const st = await s.step(s.pid, 'Inspect', { dataSchema: schema });
		expect(st.dataSchema).toEqual(schema);
	});

	test('a data schema needs unique, named fields of a known type', async () => {
		const s = await fx();
		const dup = await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'x', dataSchema: { fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'number' }] } });
		expect(dup.status).toBe(422);
		const bad = await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'x', dataSchema: { fields: [{ name: 'a', type: 'video' }] } });
		expect(bad.status).toBe(422);
	});

	test('step duration must be at least one minute and a title is required', async () => {
		const s = await fx();
		expect((await s.call('POST', `/procedures/${s.pid}/steps`, { title: 'x', estimatedDurationMinutes: 0 })).status).toBe(422);
		expect((await s.call('POST', `/procedures/${s.pid}/steps`, { title: '  ' })).status).toBe(422);
	});

	test('reorder sets the document order and keeps each step under its parent', async () => {
		const s = await fx();
		const { op1, op2, a, b, c } = await s.tree(s.pid);
		const r = await s.call('POST', `/procedures/${s.pid}/steps/reorder`, { stepIds: [op2.id, c.id, op1.id, b.id, a.id] });
		expect(r.status).toBe(200);
		expect(await s.numbers(s.pid)).toEqual([['1', 'OP two'], ['1.1', 'c'], ['2', 'OP one'], ['2.1', 'b'], ['2.2', 'a']]);
		const bad = await s.call('POST', `/procedures/${s.pid}/steps/reorder`, { stepIds: [op1.id] });
		expect(bad.status).toBe(422);
	});

	test('callouts keep author order, drop empty text and strip whitespace', async () => {
		const s = await fx();
		const mixed = [{ kind: 'info', text: 'Torque in N.m.' }, { kind: 'caution', text: 'Wear gloves.' }, { kind: 'info', text: 'Second note.' }];
		const st = await s.step(s.pid, 'mixed', { callouts: [...mixed, { kind: 'caution', text: '   ' }] });
		expect(st.callouts).toEqual(mixed);
		expect((await s.step(s.pid, 'plain')).callouts).toEqual([]);
		const one = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { callouts: [{ kind: 'info', text: '  only  ' }] });
		expect(one.callouts).toEqual([{ kind: 'info', text: 'only' }]);
		await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { title: 'same' });
		expect((await s.draft(s.pid))[0].callouts).toEqual([{ kind: 'info', text: 'only' }]);
		expect((await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { callouts: [] })).callouts).toEqual([]);
	});

	test('an unknown callout kind is refused', async () => {
		const s = await fx();
		expect((await s.call('POST', `/procedures/${s.pid}/steps`, { title: 's', callouts: [{ kind: 'danger', text: 'x' }] })).status).toBe(422);
	});

	test('every structural write leaves audit rows with the actor', async () => {
		const s = await fx();
		await s.tree(s.pid);
		const rows = s.db.select().from(auditLog).all().filter((r) => r.entity === 'procedure_step');
		expect(rows.length).toBeGreaterThanOrEqual(5);
		expect(rows.every((r) => r.actorUserId === s.author.userId)).toBe(true);
	});
});

describe('sign-off slots', () => {
	test('a leaf has Primary buyoff by default and an OP with sub-steps has none', async () => {
		const s = await fx();
		const { op1, a } = await s.tree(s.pid);
		const d = await s.draft(s.pid);
		expect(d.find((x) => x.id === a.id).signoffs).toEqual([{ label: 'Primary buyoff', role: null }]);
		expect(d.find((x) => x.id === op1.id).signoffs).toEqual([]);
		expect(d.find((x) => x.id === a.id)).toMatchObject({ requiresSignoff: false, requiredRole: null });
	});

	test('labels come from the slot position whatever the author sends', async () => {
		const s = await fx();
		await s.call('POST', '/roles', { name: 'QE' });
		const st = await s.step(s.pid, 'Run');
		const r = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, {
			signoffs: [{ label: 'Primary buyoff', role: 'Quality' }, { label: 'Second', role: null }]
		});
		expect(r.signoffs).toEqual([{ label: 'Primary buyoff', role: 'Quality' }, { label: 'Secondary buyoff', role: null }]);
		expect(r).toMatchObject({ requiresSignoff: true, requiredRole: 'Quality' });
	});

	test('a sign-off role must exist and is stored in its canonical casing', async () => {
		const s = await fx();
		const st = await s.step(s.pid, 'Run');
		expect((await s.call('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { signoffs: [{ role: 'Nobody' }] })).json.error).toBe('unknown_role');
		expect((await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { signoffs: [{ role: 'quality' }] })).signoffs[0].role).toBe('Quality');
	});

	test('requiresSignoff adds the second slot to a leaf and removes it again', async () => {
		const s = await fx();
		const st = await s.step(s.pid, 'Run', { requiredRole: 'Quality' });
		expect(st.signoffs).toHaveLength(1);
		const on = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { requiresSignoff: true });
		expect(on.signoffs.map((x: any) => x.role)).toEqual(['Quality', null]);
		const off = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { requiresSignoff: false });
		expect(off.signoffs.map((x: any) => x.role)).toEqual(['Quality']);
	});

	test('null resets the slots to the default', async () => {
		const s = await fx();
		const st = await s.step(s.pid, 'Run', { signoffs: [{ role: 'Quality' }, { role: 'Engineer' }] });
		const reset = await s.ok('PATCH', `/procedures/${s.pid}/steps/${st.id}`, { signoffs: null });
		expect(reset.signoffs).toEqual([{ label: 'Primary buyoff', role: null }]);
	});
});
