import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

/** OP 1 [1.1, 1.2], OP 2 [2.1], published. */
async function treeProc(t: Awaited<ReturnType<typeof setup>>, opts: Record<string, unknown> = {}) {
	const p = await t.proc('Tree', opts);
	const tr = await t.tree(p.id);
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return { p, tr, pid: p.id as number };
}

describe('data capture', () => {
	test('required, minimum and maximum are enforced when slot 0 is signed, and the data is kept', async () => {
		const t = await setup();
		const p = await t.proc('Capture');
		await t.step(p.id, 'Measure', {
			dataSchema: { fields: [{ name: 'torque', label: 'Torque', type: 'number', required: true, min: 1, max: 10, unit: 'Nm' }, { name: 'note', type: 'text' }] }
		});
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const none = await t.complete(e.id, '1', {});
		expect(none.status).toBe(422);
		expect(none.json.fields.torque).toBe('Torque is required');
		expect((await t.complete(e.id, '1', { dataCaptured: { torque: 0.5 } })).json.fields.torque).toContain('below minimum');
		expect((await t.complete(e.id, '1', { dataCaptured: { torque: 11 } })).json.fields.torque).toContain('above maximum');
		expect((await t.complete(e.id, '1', { dataCaptured: { torque: 'abc' } })).json.fields.torque).toContain('invalid number');
		expect((await t.get(e.id)).status).toBe('cut');
		const ok = await t.complete(e.id, '1', { dataCaptured: { torque: 5 } });
		expect(ok.status).toBe(200);
		expect(ok.json.step.dataCaptured).toEqual({ torque: 5 });
		const d = await t.doc(e.id);
		expect(d.dataRows[0]).toMatchObject({ field: 'Torque', unit: 'Nm', value: '5' });
	});

	test('a step cannot be completed twice', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		expect((await t.complete(e.id, '1')).status).toBe(200);
		const again = await t.complete(e.id, '1');
		expect(again.status).toBe(409);
		expect(again.json.message).toContain('already completed');
	});

	test('completing with notes appends a note to the step', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		await t.complete(e.id, '1', { notes: 'torqued twice' });
		const d = await t.doc(e.id);
		expect(d.ops[0].step.notes.map((n: any) => n.body)).toEqual(['torqued twice']);
	});
});

describe('sign-off slots', () => {
	test('a two-slot step is complete only after the second buyoff, and later slots sign in any order', async () => {
		const t = await setup();
		const p = await t.proc('Two slots');
		await t.step(p.id, 'Weld', { signoffs: [{ role: null }, { role: null }, { role: null }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const early = await t.sign(e.id, '1', 1);
		expect(early.status).toBe(409);
		expect(early.json.message).toContain('Primary buyoff');
		const first = await t.complete(e.id, '1');
		expect(first.json.stepCompleted).toBe(false);
		expect(first.json.step.status).toBe('awaiting_signoff');
		expect((await t.get(e.id)).status).toBe('in_work');
		await t.sign(e.id, '1', 2);
		const last = await t.sign(e.id, '1', 1);
		expect(last.json.stepCompleted).toBe(true);
		expect(last.json.step.status).toBe('completed');
		expect((await t.get(e.id)).status).toBe('completed');
		expect(last.json.signoffs.map((s: any) => s.label)).toEqual(['Primary buyoff', 'Secondary buyoff', 'Secondary buyoff']);
	});

	test('a slot cannot be signed twice and an unknown slot is 404', async () => {
		const t = await setup();
		const p = await t.proc('Two slots');
		await t.step(p.id, 'Weld', { signoffs: [{ role: null }, { role: null }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.complete(e.id, '1');
		expect((await t.complete(e.id, '1')).json.message).toContain('awaiting sign-off');
		expect((await t.sign(e.id, '1', 7)).status).toBe(404);
		await t.sign(e.id, '1', 1);
		expect((await t.sign(e.id, '1', 1)).status).toBe(409);
	});

	test('the signoff wrapper takes the next unsigned slot and refuses an unfinished step', async () => {
		const t = await setup();
		const p = await t.proc('Two slots');
		await t.step(p.id, 'Weld', { signoffs: [{ role: null }, { role: null }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const sid = await t.stepOf(e.id, '1');
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`)).status).toBe(409);
		await t.complete(e.id, '1');
		const r = await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`);
		expect(r.json.step.status).toBe('completed');
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`)).status).toBe(409);
	});

	test('a slot that names a role needs a holder of the role; an admin holds every role', async () => {
		const t = await setup();
		const p = await t.proc('Quality gate');
		await t.step(p.id, 'Inspect', { signoffs: [{ role: 'Quality' }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const refused = await t.complete(e.id, '1', {}, t.benActor);
		expect(refused.status).toBe(403);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.signoffs[0].role).toBe('Quality');
		expect((await t.complete(e.id, '1')).status).toBe(200);
	});

	test('the document says who can sign each slot and why not', async () => {
		const t = await setup();
		const p = await t.proc('Two slots');
		await t.step(p.id, 'Weld', { signoffs: [{ role: null }, { role: 'Quality' }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const before = (await t.doc(e.id)).ops[0].step.signoffs;
		expect(before[0].canSign).toBe(true);
		expect(before[1].canSign).toBe(false);
		expect(before[1].blockers[0].kind).toBe('signoff');
		await t.complete(e.id, '1');
		const asBen = await t.call('GET', `/executions/${e.id}/document`, undefined, t.benActor);
		const slot1 = asBen.json.ops[0].step.signoffs[1];
		expect(slot1.canSign).toBe(false);
		expect(slot1.blockers.map((b: any) => b.kind)).toContain('role');
		const asAdmin = (await t.doc(e.id)).ops[0].step.signoffs[1];
		expect(asAdmin.canSign).toBe(true);
	});

	test('an OP with sub-steps and no sign-offs completes by itself; with sign-offs it waits for them', async () => {
		const t = await setup();
		const { pid } = await treeProc(t);
		const e = await t.cut(pid);
		await t.complete(e.id, '1.1');
		expect((await t.doc(e.id)).ops[0].step.status).toBe('pending');
		await t.complete(e.id, '1.2');
		expect((await t.doc(e.id)).ops[0].step.status).toBe('completed');
		const direct = await t.complete(e.id, '2');
		expect(direct.status).toBe(409);

		const q = await t.proc('OP sign');
		const op = await t.step(q.id, 'OP');
		await t.step(q.id, 'sub', { parentId: op.id });
		await t.ok('PATCH', `/procedures/${q.id}/steps/${op.id}`, { signoffs: [{ role: null }] });
		await t.ok('POST', `/procedures/${q.id}/publish`, {});
		const e2 = await t.cut(q.id);
		await t.complete(e2.id, '1.1');
		const d = await t.doc(e2.id);
		expect(d.ops[0].step.status).toBe('awaiting_signoff');
		expect(d.ops[0].step.signoffs[0].canSign).toBe(true);
		expect((await t.get(e2.id)).status).toBe('in_work');
		await t.complete(e2.id, '1');
		expect((await t.get(e2.id)).status).toBe('completed');
	});
});

describe('gates', () => {
	test('a parent OP cannot be completed or skipped while sub-steps are open, but a childless OP can be skipped', async () => {
		const t = await setup();
		const { pid } = await treeProc(t);
		const e = await t.cut(pid);
		const c = await t.complete(e.id, '1');
		expect(c.status).toBe(409);
		expect(c.json.message).toContain('Waiting on sub-steps 1.1, 1.2');
		expect((await t.skip(e.id, '1')).status).toBe(409);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.completeBlockers[0].kind).toBe('children');
	});

	test('strict sequence makes a sub-step wait for the earlier ones, but skip does not', async () => {
		const t = await setup();
		const p = await t.proc('Strict');
		const op = await t.step(p.id, 'OP', { strictSequence: true });
		await t.step(p.id, 'a', { parentId: op.id });
		await t.step(p.id, 'b', { parentId: op.id });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const r = await t.complete(e.id, '1.2');
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('Waiting on 1.1');
		expect((await t.doc(e.id)).ops[0].steps[1].waiting).toBe('WAITING ON 1.1');
		expect((await t.skip(e.id, '1.2')).status).toBe(200);
		expect((await t.complete(e.id, '1.1')).status).toBe(200);
	});

	test('an OP waits for the OPs it depends on, and so do its sub-steps', async () => {
		const t = await setup();
		const { pid, tr } = await treeProc(t);
		await t.ok('PUT', `/procedures/${pid}/steps/${tr.op2.id}/dependencies`, { dependsOn: [tr.op1.id] });
		await t.ok('POST', `/procedures/${pid}/publish`, {});
		const e = await t.cut(pid);
		const r = await t.complete(e.id, '2.1');
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('Waiting on OP 1');
		expect((await t.doc(e.id)).ops[1].waitingOnOps).toEqual(['1']);
		await t.complete(e.id, '1.1');
		await t.complete(e.id, '1.2');
		expect((await t.complete(e.id, '2.1')).status).toBe(200);
	});

	test('an inactive execution refuses commitments', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		await t.ok('POST', `/executions/${e.id}/cancel`, {});
		expect((await t.skip(e.id, '1')).status).toBe(409);
		expect((await t.sign(e.id, '1', 0)).status).toBe(409);
	});

	test('a completed step cannot be skipped and a skipped step cannot be signed', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B', 'C']);
		const e = await t.cut(pid);
		await t.complete(e.id, '1');
		expect((await t.skip(e.id, '1')).status).toBe(409);
		await t.skip(e.id, '2', { reason: 'not needed' });
		expect((await t.complete(e.id, '2')).json.message).toContain('skipped');
		const d = await t.doc(e.id);
		expect(d.ops[1].step.skipReason).toBe('not needed');
		expect(d.ops[1].step.dataCaptured).toBeNull();
	});
});

describe('notes', () => {
	test('notes are appended in order, authored and audited; an empty note is refused', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		const sid = await t.stepOf(e.id, '1');
		const n1 = await t.call('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'first' });
		expect(n1.status).toBe(200);
		expect(n1.json.author.name).toBe('Author');
		await t.call('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'second' }, t.benActor);
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: '   ' })).status).toBe(422);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.notes.map((n: any) => [n.body, n.author.name])).toEqual([['first', 'Author'], ['second', 'BEN']]);
		const audit = await t.ok('GET', '/audit?entity=step_note');
		expect(audit.items.length).toBe(2);
	});

	test('a terminal step on a closed execution still takes a note, with files', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		await t.complete(e.id, '1');
		expect((await t.get(e.id)).status).toBe('completed');
		const sid = await t.stepOf(e.id, '1');
		const n = await t.ok('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'post mortem' });
		const form = new FormData();
		form.set('file', t.png());
		form.set('ownerType', 'step_note');
		form.set('ownerId', String(n.id));
		const up = await t.app.request('/api/attachments', { method: 'POST', body: form });
		expect(up.status).toBeLessThan(300);
		const d = await t.doc(e.id);
		const note = d.ops[0].step.notes[0];
		expect(note.attachments[0]).toMatchObject({ isImage: true, filename: 'x.png' });
		expect(note.attachments[0].url).toContain('/api/attachments/');
	});
});

describe('presence', () => {
	test('a claim is on the OP of the step, one per user, and several users may share an OP', async () => {
		const t = await setup();
		const { pid } = await treeProc(t);
		const e = await t.cut(pid);
		const sub = await t.stepOf(e.id, '1.2');
		const op1 = await t.stepOf(e.id, '1');
		const op2 = await t.stepOf(e.id, '2');
		const r = await t.ok('POST', `/executions/${e.id}/focus`, { stepId: sub });
		expect(r.stepId).toBe(op1);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: op1 });
		await t.call('POST', `/executions/${e.id}/focus`, { stepId: op1 }, t.benActor);
		let d = await t.doc(e.id);
		expect(d.ops[0].step.cursors.map((c: any) => c.name).sort()).toEqual(['Author', 'BEN']);
		expect(d.roster).toHaveLength(2);
		expect(d.myCursorId).toBe(op1);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: op2 });
		d = await t.doc(e.id);
		expect(d.ops[0].step.cursors.map((c: any) => c.name)).toEqual(['BEN']);
		expect(d.ops[1].step.cursors.map((c: any) => c.name)).toEqual(['Author']);
		expect(d.ops[1].step.cursors[0].initials).toBe('AU');
		await t.ok('DELETE', `/executions/${e.id}/focus`);
		expect((await t.doc(e.id)).myCursorId).toBeNull();
	});

	test('leaving keeps the claim; releasing clears it; join lists participants', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		const a = await t.stepOf(e.id, '1');
		await t.ok('POST', `/executions/${e.id}/join`);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		expect((await t.ok('GET', `/executions/${e.id}/participants`)).participants.map((p: any) => p.name)).toEqual(['Author']);
		await t.ok('POST', `/executions/${e.id}/leave`);
		expect((await t.ok('GET', `/executions/${e.id}/participants`)).participants).toEqual([]);
		expect((await t.doc(e.id)).myCursorId).toBe(a);
		await t.ok('DELETE', `/executions/${e.id}/focus`);
		expect((await t.doc(e.id)).roster).toEqual([]);
	});

	test('a finished OP or an OP that waits on another cannot be claimed', async () => {
		const t = await setup();
		const { pid, tr } = await treeProc(t);
		await t.ok('PUT', `/procedures/${pid}/steps/${tr.op2.id}/dependencies`, { dependsOn: [tr.op1.id] });
		await t.ok('POST', `/procedures/${pid}/publish`, {});
		const e = await t.cut(pid);
		const op2 = await t.stepOf(e.id, '2');
		expect((await t.call('POST', `/executions/${e.id}/focus`, { stepId: op2 })).status).toBe(409);
		await t.complete(e.id, '1.1');
		await t.complete(e.id, '1.2');
		const op1 = await t.stepOf(e.id, '1');
		const done = await t.call('POST', `/executions/${e.id}/focus`, { stepId: op1 });
		expect(done.status).toBe(409);
		expect(done.json.message).toContain('finished');
		expect((await t.call('POST', `/executions/${e.id}/focus`, { stepId: op2 })).status).toBe(200);
	});

	test('a claim on an OP ends when the OP finishes', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: await t.stepOf(e.id, '1') });
		await t.complete(e.id, '1');
		expect((await t.doc(e.id)).roster).toEqual([]);
		expect((await t.ok('GET', `/executions/${e.id}/state`)).roster).toEqual([]);
	});

	test('the state poll counts leaf steps and reports step statuses', async () => {
		const t = await setup();
		const { pid } = await treeProc(t);
		const e = await t.cut(pid);
		await t.complete(e.id, '1.1');
		const s = await t.ok('GET', `/executions/${e.id}/state`);
		expect(s.execution.progress).toEqual({ done: 1, total: 3 });
		expect(s.steps.find((x: any) => x.number === '1.1').status).toBe('completed');
	});
});

describe('the document', () => {
	test('it nests sub-steps under OPs with their numbers and progress', async () => {
		const t = await setup();
		const { pid } = await treeProc(t);
		const e = await t.cut(pid);
		await t.complete(e.id, '1.1');
		const d = await t.doc(e.id);
		expect(d.ops.map((o: any) => o.number)).toEqual(['1', '2']);
		expect(d.ops[0].steps.map((s: any) => s.number)).toEqual(['1.1', '1.2']);
		expect(d.ops[0].progress).toEqual({ done: 1, total: 2 });
		expect(d.progress).toEqual({ done: 1, total: 3 });
		expect(d.execution.procedure.type).toBe('op');
		expect(d.execution.projectCode).toBe(t.proj.code);
		expect(d.ops[0].steps[0].completed.initials).toBe('AU');
	});
});
