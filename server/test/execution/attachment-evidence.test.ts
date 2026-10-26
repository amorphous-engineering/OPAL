import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;

async function upload(t: T, ownerType: string, ownerId: number, kind: string) {
	const form = new FormData();
	form.set('file', t.png());
	form.set('ownerType', ownerType);
	form.set('ownerId', String(ownerId));
	form.set('kind', kind);
	return t.app.request('/api/attachments', { method: 'POST', body: form });
}

/** A one-step photo procedure, cut, with one capture on the step. */
async function withCapture(t: T) {
	const p = await t.proc('Evidence');
	await t.step(p.id, 'Shoot', { dataSchema: { fields: [{ name: 'shot', type: 'photo', required: true }] } });
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	const e = await t.cut(p.id);
	const sid = await t.stepOf(e.id, '1');
	const id = ((await (await upload(t, 'step_execution', sid, 'capture')).json()) as { id: number }).id;
	return { e, sid, id };
}

describe('attachment evidence', () => {
	test('a completed step takes no new, re-kinded or detached capture', async () => {
		const t = await setup();
		const { e, sid, id } = await withCapture(t);
		expect((await t.complete(e.id, '1', { dataCaptured: { shot: [id] } })).status).toBe(200);
		const add = await upload(t, 'step_execution', sid, 'capture');
		expect(add.status).toBe(409);
		expect((await t.call('PATCH', `/attachments/${id}`, { kind: 'reference' })).status).toBe(409);
		const del = await t.call('DELETE', `/attachments/${id}`);
		expect(del.status).toBe(409);
		expect((await t.doc(e.id)).ops[0].step.attachments.map((a: any) => a.id)).toEqual([id]);
	});

	test('a capture that signed data references cannot be detached', async () => {
		const t = await setup();
		const { e, id } = await withCapture(t);
		await t.complete(e.id, '1', { dataCaptured: { shot: [id] } });
		// Reopen step and execution directly, so only the reference is left to block the detach.
		t.db.run(sql`UPDATE step_execution SET status = 'pending'`);
		t.db.run(sql`UPDATE execution SET status = 'in_work'`);
		const del = await t.call('DELETE', `/attachments/${id}`);
		expect(del.status).toBe(409);
		expect(del.json.message).toContain('signed data');
	});

	test('an open step still takes and drops captures', async () => {
		const t = await setup();
		const { id } = await withCapture(t);
		expect((await t.call('PATCH', `/attachments/${id}`, { note: 'torque' })).status).toBe(200);
		expect((await t.call('DELETE', `/attachments/${id}`)).status).toBe(200);
	});

	test('an execution that is not active freezes the evidence of its open steps', async () => {
		const t = await setup();
		const { e, sid, id } = await withCapture(t);
		await t.ok('POST', `/executions/${e.id}/cancel`, {});
		expect((await upload(t, 'step_execution', sid, 'capture')).status).toBe(409);
		expect((await t.call('DELETE', `/attachments/${id}`)).status).toBe(409);
	});

	test('step note and closeout files cannot be re-kinded or detached after the execution ends', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		const sid = await t.stepOf(e.id, '1');
		const n = await t.ok('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'n' });
		const noteFile = ((await (await upload(t, 'step_note', n.id, 'reference')).json()) as { id: number }).id;
		const closeout = ((await (await upload(t, 'execution', e.id, 'closeout')).json()) as { id: number }).id;
		await t.complete(e.id, '1');
		expect((await t.get(e.id)).status).toBe('completed');
		for (const id of [noteFile, closeout]) {
			expect((await t.call('PATCH', `/attachments/${id}`, { kind: 'reference' })).status).toBe(409);
			expect((await t.call('DELETE', `/attachments/${id}`)).status).toBe(409);
		}
		// Appending stays open: a post mortem note takes files.
		expect((await upload(t, 'step_note', n.id, 'reference')).status).toBe(201);
	});
});
