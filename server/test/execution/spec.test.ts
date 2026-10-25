import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

const RANGE = { kind: 'range', lower: '12.125', upper: '12.25' };

/** A published one-step procedure with a spec'd depth field (and an optional legacy field). */
async function specProc(t: Awaited<ReturnType<typeof setup>>, fields?: unknown[]) {
	const p = await t.proc('Spec ' + Math.random().toString(36).slice(2, 6));
	await t.step(p.id, 'Measure', {
		dataSchema: { fields: fields ?? [{ name: 'depth', label: 'Piston depth', type: 'number', unit: 'in', spec: RANGE }] }
	});
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return t.cut(p.id);
}

describe('out-of-spec capture', () => {
	test('a field with a spec stores an out-of-spec value, but the step cannot complete without a note or an NC', async () => {
		const t = await setup();
		const e = await specProc(t);
		const r = await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } });
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('Piston depth 12.3 in is out of spec (12.125 – 12.25 in): add a note or raise an NC');
		expect((await t.get(e.id)).status).toBe('cut');
	});

	test('a note on the step clears the out_of_spec blocker, and the value is kept and flagged', async () => {
		const t = await setup();
		const e = await specProc(t);
		const sid = await t.stepOf(e.id, '1');
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } })).status).toBe(409);
		await t.ok('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'Shim added, within drawing tolerance' });
		const ok = await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } });
		expect(ok.status).toBe(200);
		expect(ok.json.step.dataCaptured).toEqual({ depth: 12.3 });
		const d = await t.doc(e.id);
		expect(d.dataRows[0]).toMatchObject({ unit: 'in', spec: '12.125 – 12.25 in', outOfSpec: true });
	});

	test('notes sent with the completion clear the out_of_spec blocker', async () => {
		const t = await setup();
		const e = await specProc(t);
		const ok = await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 }, notes: 'Re-measured twice' });
		expect(ok.status).toBe(200);
	});

	test('an NC raised from the step clears the out_of_spec blocker', async () => {
		const t = await setup();
		const e = await specProc(t);
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } })).status).toBe(409);
		// Advisory containment: the NC explains the value and does not hold the step itself.
		const raised = await t.nc(e.id, '1', { containment: 'advisory', priority: 'low' });
		expect(raised.status).toBeLessThan(300);
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } })).status).toBe(200);
	});

	test('a value changed back into spec completes without a note', async () => {
		const t = await setup();
		const e = await specProc(t);
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 12.3 } })).status).toBe(409);
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 12.25 } })).status).toBe(200);
	});

	test('legacy min and max still refuse a value on a field without a spec', async () => {
		const t = await setup();
		const e = await specProc(t, [{ name: 'torque', type: 'number', min: 1, max: 10 }]);
		const r = await t.complete(e.id, '1', { dataCaptured: { torque: 11 } });
		expect(r.status).toBe(422);
		expect(r.json.fields.torque).toContain('above maximum');
	});

	test('a required spec field and an invalid number are still refused', async () => {
		const t = await setup();
		const e = await specProc(t, [{ name: 'depth', type: 'number', required: true, unit: 'in', spec: RANGE }]);
		expect((await t.complete(e.id, '1', {})).status).toBe(422);
		expect((await t.complete(e.id, '1', { dataCaptured: { depth: 'abc' } })).json.fields.depth).toContain('invalid number');
	});

	test('the document lists the out_of_spec blocker only when the stored value is out of spec and unexplained', async () => {
		const t = await setup();
		const e = await specProc(t);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.completeBlockers.filter((b: any) => b.kind === 'out_of_spec')).toEqual([]);
	});

	test('report rows carry the unit symbol, the spec text and the out-of-spec flag', async () => {
		const t = await setup();
		const e = await specProc(t, [
			{ name: 'depth', label: 'Piston depth', type: 'number', unit: 'in_lbf', spec: { kind: 'min', lower: '5' } },
			{ name: 'ok', type: 'number', unit: 'mm' }
		]);
		await t.complete(e.id, '1', { dataCaptured: { depth: 4, ok: 1 }, notes: 'low, accepted' });
		const rep = await t.ok('GET', `/executions/${e.id}/report`);
		expect(rep.dataCollects[0].rows).toEqual([
			{ label: 'Piston depth', value: '4', unit: 'in·lbf', spec: '≥ 5 in·lbf', outOfSpec: true },
			{ label: 'ok', value: '1', unit: 'mm', spec: null, outOfSpec: false }
		]);
	});
});

describe('authoring units and specs', () => {
	test('an unknown unit code is refused on a new or changed field', async () => {
		const t = await setup();
		const p = await t.proc('Units');
		const r = await t.call('POST', `/procedures/${p.id}/steps`, {
			title: 'Measure',
			dataSchema: { fields: [{ name: 'x', type: 'number', unit: 'furlong' }] }
		});
		expect(r.status).toBe(422);
		expect(r.json.message).toContain("unknown unit 'furlong'");
	});

	test('a spec on a field that is not a number is refused', async () => {
		const t = await setup();
		const p = await t.proc('Spec text');
		const r = await t.call('POST', `/procedures/${p.id}/steps`, {
			title: 'Measure',
			dataSchema: { fields: [{ name: 'x', type: 'text', spec: RANGE }] }
		});
		expect(r.status).toBe(422);
	});

	test('a spec together with min or max is refused', async () => {
		const t = await setup();
		const p = await t.proc('Spec min');
		const r = await t.call('POST', `/procedures/${p.id}/steps`, {
			title: 'Measure',
			dataSchema: { fields: [{ name: 'x', type: 'number', spec: RANGE, max: 3 }] }
		});
		expect(r.status).toBe(422);
	});
});
