import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLog, procedure, procedureStep } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

/** A released template made obsolete, with its steps. */
async function retired() {
	const s = await setup();
	const { id, version } = await s.published('Retired', ['A', 'B']);
	const r = await s.call('POST', `/procedures/${id}/obsolete`, { reason: 'Superseded by T-9' });
	expect(r.status).toBe(200);
	const [first] = await s.draft(id);
	return { s, id, version, stepId: first.id as number };
}

describe('obsolete templates are read-only', () => {
	test('publishing an obsolete template is refused and leaves it obsolete', async () => {
		const { s, id } = await retired();
		const r = await s.call('POST', `/procedures/${id}/publish`, {});
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('procedure_obsolete');
		const p = await s.ok('GET', `/procedures/${id}`);
		expect(p.status).toBe('obsolete');
		expect(p.currentVersionNumber).toBe(1);
	});

	test('editing the draft of an obsolete template is refused', async () => {
		const { s, id, stepId, version } = await retired();
		const attempts = [
			s.call('POST', `/procedures/${id}/steps`, { title: 'New' }),
			s.call('PATCH', `/procedures/${id}/steps/${stepId}`, { title: 'Changed' }),
			s.call('DELETE', `/procedures/${id}/steps/${stepId}`),
			s.call('POST', `/procedures/${id}/steps/${stepId}/duplicate`),
			s.call('POST', `/procedures/${id}/versions/${version.id}/restore`),
			s.call('PATCH', `/procedures/${id}`, { name: 'Changed' })
		];
		for (const r of await Promise.all(attempts)) {
			expect(r.status).toBe(409);
			expect(r.json.error).toBe('procedure_obsolete');
		}
		const titles = (await s.draft(id)).map((x) => x.title);
		expect(titles).toEqual(['A', 'B']);
	});

	test('the kit and outputs of an obsolete template are refused', async () => {
		const { s, id } = await retired();
		const part = await s.part('Washer');
		const kit = await s.call('POST', `/procedures/${id}/kit`, { partId: part.id, quantity: '1' });
		expect(kit.json.error).toBe('procedure_obsolete');
		const out = await s.call('POST', `/procedures/${id}/outputs`, { partId: part.id, quantity: '1' });
		expect(out.json.error).toBe('procedure_obsolete');
	});

	test('an obsolete template can still be read and cloned', async () => {
		const { s, id } = await retired();
		expect((await s.call('GET', `/procedures/${id}/draft`)).status).toBe(200);
		const copy = await s.call('POST', `/procedures/${id}/clone`, {});
		expect(copy.status).toBe(200);
		expect(copy.json.status).toBe('draft');
	});
});

describe('retiring and reinstating', () => {
	test('making a template obsolete needs a reason, which stays on the record', async () => {
		const s = await setup();
		const { id } = await s.published('Needs reason');
		expect((await s.call('POST', `/procedures/${id}/obsolete`, { reason: '  ' })).status).toBe(422);
		expect((await s.call('POST', `/procedures/${id}/obsolete`, {})).status).toBe(422);
		const r = await s.call('POST', `/procedures/${id}/obsolete`, { reason: ' Superseded ' });
		expect(r.json).toMatchObject({ status: 'obsolete', statusReason: 'Superseded' });
		const rows = s.db.select().from(auditLog).where(eq(auditLog.entity, 'procedure')).all();
		expect(rows.some((a) => (a.after as { statusReason?: string } | null)?.statusReason === 'Superseded')).toBe(true);
	});

	test('only a released template can be made obsolete', async () => {
		const s = await setup();
		const draft = await s.proc('Still pencil');
		const r = await s.call('POST', `/procedures/${draft.id}/obsolete`, { reason: 'x' });
		expect(r.status).toBe(409);
		expect(r.json.error).toBe('not_released');
	});

	test('reinstating needs a reason, and returns the template to released', async () => {
		const { s, id } = await retired();
		expect((await s.call('POST', `/procedures/${id}/reinstate`, {})).status).toBe(422);
		const r = await s.call('POST', `/procedures/${id}/reinstate`, { reason: 'Customer asked again' });
		expect(r.json).toMatchObject({ status: 'released', statusReason: 'Customer asked again' });
		const edit = await s.call('POST', `/procedures/${id}/steps`, { title: 'Allowed again' });
		expect(edit.status).toBe(200);
	});

	test('reinstating a template that is not obsolete is refused', async () => {
		const s = await setup();
		const { id } = await s.published('Live');
		const r = await s.call('POST', `/procedures/${id}/reinstate`, { reason: 'x' });
		expect(r.json.error).toBe('not_obsolete');
	});

	test('an obsolete template that was never published goes back to draft', async () => {
		const s = await setup();
		const p = await s.proc('Imported');
		s.db.update(procedure).set({ status: 'obsolete' }).where(eq(procedure.id, p.id)).run();
		const r = await s.call('POST', `/procedures/${p.id}/reinstate`, { reason: 'Import was wrong' });
		expect(r.json.status).toBe('draft');
	});

	test('retiring and reinstating need a person, not an API token', async () => {
		const s = await setup();
		const { id } = await s.published('Human only');
		const a = await s.call('POST', `/procedures/${id}/obsolete`, { reason: 'x' }, s.token);
		expect(a.status).toBe(403);
		await s.ok('POST', `/procedures/${id}/obsolete`, { reason: 'x' });
		const b = await s.call('POST', `/procedures/${id}/reinstate`, { reason: 'x' }, s.token);
		expect(b.status).toBe(403);
	});
});

describe('publishing is a person act', () => {
	test('an API token can draft but cannot publish', async () => {
		const s = await setup();
		const p = await s.proc('Agent draft');
		const added = await s.call('POST', `/procedures/${p.id}/steps`, { title: 'Drafted by agent' }, s.token);
		expect(added.status).toBe(200);
		const r = await s.call('POST', `/procedures/${p.id}/publish`, {}, s.token);
		expect(r.status).toBe(403);
		expect((await s.ok('GET', `/procedures/${p.id}`)).status).toBe('draft');
	});
});

describe('undo is for pencil', () => {
	test('undoing a step edit of an obsolete template is refused', async () => {
		const { s, id, stepId } = await retired();
		await s.ok('POST', `/procedures/${id}/reinstate`, { reason: 'x' });
		await s.ok('PATCH', `/procedures/${id}/steps/${stepId}`, { title: 'Edited' });
		await s.ok('POST', `/procedures/${id}/obsolete`, { reason: 'y' });
		// The newest action is the retiring, which no undo reaches past.
		const pre = await s.ok('GET', '/undo/last');
		expect(pre.canUndo).toBe(false);
		expect((await s.call('POST', '/undo/last')).status).toBe(409);
		expect(s.db.select().from(procedureStep).where(eq(procedureStep.id, stepId)).get()!.title).toBe('Edited');
	});

	test('undoing a step edit of a draft that is still pencil works', async () => {
		const s = await setup();
		const p = await s.proc('Pencil');
		const st = await s.step(p.id, 'First');
		await s.ok('PATCH', `/procedures/${p.id}/steps/${st.id}`, { title: 'Second' });
		expect((await s.ok('GET', '/undo/last')).canUndo).toBe(true);
		await s.ok('POST', '/undo/last');
		expect(s.db.select().from(procedureStep).where(eq(procedureStep.id, st.id)).get()!.title).toBe('First');
	});

	test('a template header edit cannot be undone once the template has a version', async () => {
		const s = await setup();
		const { id } = await s.published('Committed');
		await s.ok('PATCH', `/procedures/${id}`, { name: 'Renamed' });
		expect((await s.ok('GET', '/undo/last')).canUndo).toBe(false);
		expect((await s.call('POST', '/undo/last')).status).toBe(409);
		expect((await s.ok('GET', `/procedures/${id}`)).name).toBe('Renamed');
	});

	test('retiring a template is not reversible by undo', async () => {
		const s = await setup();
		const { id } = await s.published('Stamped');
		await s.ok('POST', `/procedures/${id}/obsolete`, { reason: 'x' });
		expect((await s.ok('GET', '/undo/last')).canUndo).toBe(false);
	});
});
