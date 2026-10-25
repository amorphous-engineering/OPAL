import { describe, expect, test } from 'bun:test';
import { makePart, receive, setup } from './helpers.ts';

async function withRecord() {
	const s = await setup();
	const p = makePart(s.db, { tracking: 'serialized' });
	const rec = await receive(s, p.id, '1');
	return { s, p, rec };
}

describe('test templates', () => {
	test('templates are created per part in sort order and can be deleted', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const b = await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'B', sortOrder: 2 });
		expect(b.status).toBe(201);
		await s.call('POST', `/inventory/parts/${p.id}/test-templates`, {
			name: 'A',
			sortOrder: 1,
			required: true,
			testType: 'numeric',
			minValue: '1.5',
			maxValue: '2',
			unit: 'V'
		});
		const list = await s.call('GET', `/inventory/parts/${p.id}/test-templates`);
		expect(list.body.map((t: { name: string }) => t.name)).toEqual(['A', 'B']);
		expect(list.body[0]).toMatchObject({ required: true, minValue: '1.5', maxValue: '2', unit: 'V' });
		expect((await s.call('DELETE', `/inventory/parts/${p.id}/test-templates/${b.body.id}`)).status).toBe(200);
		expect((await s.call('DELETE', `/inventory/parts/${p.id}/test-templates/${b.body.id}`)).status).toBe(404);
		expect((await s.call('GET', '/inventory/parts/999/test-templates')).status).toBe(404);
	});
});

describe('test results', () => {
	test('a result is stamped with tester and time unless it is pending', async () => {
		const { s, rec } = await withRecord();
		const pending = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Hi-pot' });
		expect(pending.status).toBe(201);
		expect(pending.body).toMatchObject({ result: 'pending', testedAt: null });
		const done = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Leak', result: 'pass', value: '0.1' });
		expect(done.body.testedAt).not.toBeNull();
		expect(done.body.testedByName).toBe('Ada Admin');
	});

	test('changing a pending result to pass stamps the tester once', async () => {
		const { s, rec } = await withRecord();
		const t = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Hi-pot' });
		const up = await s.call('PATCH', `/inventory/${rec.id}/tests/${t.body.id}`, { testName: 'Hi-pot', result: 'pass', notes: 'ok' });
		expect(up.body).toMatchObject({ result: 'pass', notes: 'ok', testedByName: 'Ada Admin' });
		const first = up.body.testedAt;
		const again = await s.call('PATCH', `/inventory/${rec.id}/tests/${t.body.id}`, { testName: 'Hi-pot', result: 'fail' });
		expect(again.body.testedAt).toBe(first);
	});

	test('a result can name a template, and an unknown template is refused', async () => {
		const { s, rec, p } = await withRecord();
		const tpl = await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'Torque' });
		const ok = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', templateId: tpl.body.id, result: 'pass' });
		expect(ok.body.templateId).toBe(tpl.body.id);
		const bad = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'x', templateId: 999 });
		expect(bad.status).toBe(404);
	});

	test('deleting a template keeps the results that used it, under their test name', async () => {
		const { s, rec, p } = await withRecord();
		const tpl = await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'Torque' });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', templateId: tpl.body.id, result: 'pass' });
		await s.call('DELETE', `/inventory/parts/${p.id}/test-templates/${tpl.body.id}`);
		const list = await s.call('GET', `/inventory/${rec.id}/tests`);
		expect(list.body).toHaveLength(1);
		expect(list.body[0]).toMatchObject({ testName: 'Torque', templateId: null });
	});

	test('a result can be deleted, and a wrong record or id is not found', async () => {
		const { s, rec } = await withRecord();
		const t = await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'A', result: 'pass' });
		expect((await s.call('DELETE', `/inventory/${rec.id}/tests/${t.body.id}`)).status).toBe(200);
		expect((await s.call('DELETE', `/inventory/${rec.id}/tests/${t.body.id}`)).status).toBe(404);
		expect((await s.call('POST', '/inventory/999/tests', { testName: 'A' })).status).toBe(404);
	});

	test('test status counts results and tracks the required tests of the part', async () => {
		const { s, rec, p } = await withRecord();
		const req = await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'Torque', required: true });
		const empty = await s.call('GET', `/inventory/${rec.id}/test-status`);
		expect(empty.body).toMatchObject({ total: 0, requiredPassed: false, missingRequired: ['Torque'], overall: 'pending' });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', templateId: req.body.id, result: 'fail' });
		const failed = await s.call('GET', `/inventory/${rec.id}/test-status`);
		expect(failed.body).toMatchObject({ failed: 1, overall: 'fail', requiredPassed: false });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', templateId: req.body.id, result: 'pass' });
		const mixed = await s.call('GET', `/inventory/${rec.id}/test-status`);
		expect(mixed.body).toMatchObject({ passed: 1, failed: 1, requiredPassed: true, overall: 'fail' });
	});

	test('overall status is pass only when nothing failed or pends and required tests passed', async () => {
		const { s, rec, p } = await withRecord();
		const req = await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'Torque', required: true });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', templateId: req.body.id, result: 'pass' });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Visual' });
		expect((await s.call('GET', `/inventory/${rec.id}/test-status`)).body.overall).toBe('pending');
		const list = await s.call('GET', `/inventory/${rec.id}/tests`);
		const visual = list.body.find((t: { testName: string }) => t.testName === 'Visual');
		await s.call('PATCH', `/inventory/${rec.id}/tests/${visual.id}`, { testName: 'Visual', result: 'pass' });
		expect((await s.call('GET', `/inventory/${rec.id}/test-status`)).body.overall).toBe('pass');
	});

	test('the record page lists the part templates and the results', async () => {
		const { s, rec, p } = await withRecord();
		await s.call('POST', `/inventory/parts/${p.id}/test-templates`, { name: 'Torque' });
		await s.call('POST', `/inventory/${rec.id}/tests`, { testName: 'Torque', result: 'pass' });
		const d = await s.call('GET', `/inventory/opal/${rec.opalNumber}/detail`);
		expect(d.body.testTemplates).toHaveLength(1);
		expect(d.body.tests).toHaveLength(1);
		expect(d.body.testStatus.passed).toBe(1);
	});
});

describe('labels', () => {
	test('stock and part labels carry the identifier and a QR code that opens the page', async () => {
		const { s, p, rec } = await withRecord();
		const r = await s.call(
			'GET',
			`/inventory/labels?inventory=${rec.opalNumber}&part=${p.id}&origin=http://opal.test/`
		);
		expect(r.status).toBe(200);
		expect(r.body.failures).toEqual([]);
		const [stock, part] = r.body.labels;
		expect(stock).toMatchObject({
			kind: 'stock',
			primary: rec.opalNumber,
			secondary: p.internalPn,
			url: `http://opal.test/inventory/opal/${rec.opalNumber}`
		});
		expect(stock.qrSvg.startsWith('<svg')).toBe(true);
		expect(part).toMatchObject({ kind: 'part', primary: p.internalPn, url: `http://opal.test/parts/${p.id}` });
	});

	test('a label that cannot be made is reported, and the others still print', async () => {
		const { s, rec } = await withRecord();
		const r = await s.call('GET', `/inventory/labels?inventory=${rec.opalNumber},OPAL-9999&part=abc`);
		expect(r.body.labels).toHaveLength(1);
		expect(r.body.failures).toHaveLength(2);
	});
});
