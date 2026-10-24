import { describe, expect, test } from 'bun:test';
import { captureDisplay } from '../../src/services/execution/document.ts';
import { setup } from './helpers.ts';

async function dataset(t: Awaited<ReturnType<typeof setup>>, fields: unknown[]) {
	return t.ok('POST', '/datasets', { projectId: t.proj.id, name: 'Chamber', schema: { fields } });
}

describe('report', () => {
	test('a report exists only for a completed execution', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const r = await t.call('GET', `/executions/${e.id}/report`);
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('CUT');
		await t.complete(e.id, '1');
		expect((await t.call('GET', `/executions/${e.id}/report`)).status).toBe(200);
	});

	test('the report lists operations with signatures, labelled captured data, issues and only closeout files', async () => {
		const t = await setup();
		const p = await t.proc('Reported');
		await t.step(p.id, 'Measure', {
			dataSchema: { fields: [{ name: 'p', label: 'Chamber pressure', type: 'number', unit: 'bar' }, { name: 'ok', type: 'checkbox' }] },
			signoffs: [{ role: null }, { role: null }]
		});
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.complete(e.id, '1', { dataCaptured: { p: 12.5, ok: true } });
		await t.sign(e.id, '1', 1, {}, t.benActor);
		const sid = await t.stepOf(e.id, '1');
		const note = await t.ok('POST', `/executions/${e.id}/steps/${sid}/notes`, { body: 'n' });
		void note;
		const upload = async (kind: string) => {
			const form = new FormData();
			form.set('file', t.png());
			form.set('ownerType', 'execution');
			form.set('ownerId', String(e.id));
			form.set('kind', kind);
			await t.app.request('/api/attachments', { method: 'POST', body: form });
		};
		await upload('closeout');
		await upload('reference');
		const r = await t.ok('GET', `/executions/${e.id}/report`);
		expect(r.execution).toMatchObject({ woNumber: e.woNumber, versionNumber: 1, projectCode: t.proj.code });
		expect(r.operations[0].signoffs.map((s: any) => [s.label, s.signedBy])).toEqual([['Primary buyoff', 'Author'], ['Secondary buyoff', 'BEN']]);
		expect(r.dataCollects[0].rows).toEqual([
			{ label: 'Chamber pressure', value: '12.5', unit: 'bar' },
			{ label: 'ok', value: 'YES', unit: null }
		]);
		expect(r.closeoutAttachments).toHaveLength(1);
	});

	test('the report charts numeric chart fields of datasets tied to the execution', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['Read']));
		await t.complete(e.id, '1');
		const sid = await t.stepOf(e.id, '1');
		const ds = await dataset(t, [{ name: 'p', type: 'number', chart: true }, { name: 'label', type: 'text' }]);
		const other = await dataset(t, [{ name: 'q', type: 'number' }]);
		await t.ok('POST', `/datasets/${ds.id}/points`, { values: { p: 3 }, stepExecutionId: sid });
		await t.ok('POST', `/datasets/${other.id}/points`, { values: { q: 3 }, stepExecutionId: sid });
		await t.ok('POST', `/datasets/${ds.id}/points`, { values: { p: 9 } });
		const r = await t.ok('GET', `/executions/${e.id}/report`);
		expect(r.chartDatasets).toHaveLength(1);
		expect(r.chartDatasets[0].chartFields.map((f: any) => f.name)).toEqual(['p']);
		expect(r.chartDatasets[0].points).toHaveLength(1);
	});

	test('the QR code links to the execution page', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const res = await t.call('GET', `/executions/${e.id}/qr.svg?origin=http://shop.local:8080`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('image/svg+xml');
		expect(res.text).toContain('<svg');
		expect((await t.call('GET', `/executions/${e.id}/qr.svg?origin=ftp://x`)).status).toBe(422);
	});
});

describe('datasets', () => {
	test('a data point resolves its source step and an unknown step execution is refused', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['Read chamber pressure']));
		const sid = await t.stepOf(e.id, '1');
		const ds = await dataset(t, [{ name: 'p', type: 'number' }]);
		const pt = await t.ok('POST', `/datasets/${ds.id}/points`, { values: { p: 3 }, stepExecutionId: sid });
		expect(pt.source).toMatchObject({ executionId: e.id, woNumber: e.woNumber, stepNumber: '1', stepTitle: 'Read chamber pressure' });
		const listed = await t.ok('GET', `/datasets/${ds.id}/points`);
		expect(listed.items[0].source.woNumber).toBe(e.woNumber);
		const missing = await t.call('POST', `/datasets/${ds.id}/points`, { values: { p: 1 }, stepExecutionId: 99999 });
		expect(missing.status).toBe(422);
		expect((await t.ok('POST', `/datasets/${ds.id}/points`, { values: { p: 1 } })).source).toBeNull();
	});
});

describe('other areas', () => {
	test('the workcenter queue counts unfinished steps of open executions that run there', async () => {
		const t = await setup();
		const wc = await t.ok('POST', '/workcenters', { name: 'Weld bay', code: 'wb' });
		const p = await t.proc('Queued');
		await t.step(p.id, 'Weld', { workcenterId: wc.id });
		await t.step(p.id, 'Paint');
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id, { priority: 'urgent' });
		const list = await t.ok('GET', '/workcenters');
		expect(list.find((w: any) => w.id === wc.id).queuedStepCount).toBe(1);
		const work = await t.ok('GET', `/workcenters/${wc.id}/work`);
		expect(work.queue[0]).toMatchObject({ instanceId: e.id, workOrderNumber: e.woNumber, stepNumberStr: '1', stepStatus: 'pending', priority: 2 });
		await t.complete(e.id, '1');
		expect((await t.ok('GET', '/workcenters')).find((w: any) => w.id === wc.id).queuedStepCount).toBe(0);
	});

	test('the procedure counts its executions', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		await t.cut(pid, { quantity: 2 });
		expect((await t.ok('GET', `/procedures/${pid}`)).executionCount).toBe(2);
	});

	test('the overview lists active executions, blocked ones first, with progress', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const quiet = await t.cut(pid);
		const held = await t.cut(pid, { targetCompletionAt: '2020-01-01T00:00:00Z' });
		await t.nc(held.id, '1');
		await t.complete(quiet.id, '1');
		const done = await t.cut(pid);
		await t.complete(done.id, '1');
		await t.complete(done.id, '2');
		const o = (await t.ok('GET', '/overview')).executions;
		expect(o.total).toBe(2);
		expect(o.flagged).toBe(1);
		expect(o.items[0]).toMatchObject({ label: held.woNumber, blocked: true, overdue: true, href: `/executions/${held.id}` });
		expect(o.items[1]).toMatchObject({ label: quiet.woNumber, stepsDone: 1, stepsTotal: 2, blocked: false });
	});

	test('the overview and the execution CSV count progress like the list: leaf steps, contingency excluded', async () => {
		const t = await setup();
		const p = await t.proc('Counted');
		await t.step(p.id, 'Main');
		await t.step(p.id, 'Next');
		await t.step(p.id, 'Spare', { isContingency: true });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.complete(e.id, '1');
		const row = (await t.ok('GET', '/overview')).executions.items[0];
		expect([row.stepsDone, row.stepsTotal]).toEqual([1, 2]);
		const list = (await t.ok('GET', '/executions')).items[0];
		expect([list.progressDone, list.progressTotal]).toEqual([row.stepsDone, row.stepsTotal]);
	});

	test('a captured photo shows its count, never attachment ids', () => {
		expect(captureDisplay([7])).toBe('1 image');
		expect(captureDisplay([7, 9])).toBe('2 images');
		expect(captureDisplay([])).toBe('—');
	});

	test('the executions CSV and the metrics come from the execution rows', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid, { priority: 'high' });
		await t.complete(e.id, '1');
		await t.cut(pid);
		const csv = await t.call('GET', '/reports/executions/csv');
		const lines = csv.text.trim().split('\n');
		expect(lines).toHaveLength(3);
		expect(lines.find((l: string) => l.includes(e.woNumber))).toContain('completed');
		const m = await t.ok('GET', '/reports/analytics/executions');
		expect(m).toMatchObject({ totalExecutions: 2, completed: 1, cut: 1 });
	});

	test('search finds an execution by work order number', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const hits = await t.ok('GET', `/search?q=${e.woNumber}`);
		expect(hits.some((h: any) => h.href === `/executions/${e.id}`)).toBe(true);
	});

	test('undo reverses an abort', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		await t.ok('POST', `/executions/${e.id}/cancel`, {});
		await t.ok('POST', '/undo/last');
		expect((await t.get(e.id)).status).toBe('cut');
	});

	test('every execution operation is exposed to MCP except the page-only reads', async () => {
		const { contracts } = await import('@opal/shared');
		const off = Object.values(contracts.execution).filter((c: any) => !c.mcp).map((c: any) => c.name);
		expect(off.sort()).toEqual(['execution.document', 'execution.qr']);
	});
});
