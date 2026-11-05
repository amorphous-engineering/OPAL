/** The part page shows where the part is used and what was consumed. */
import { describe, expect, test } from 'bun:test';
import { setup } from '../execution/helpers.ts';

describe('procedure use of a part', () => {
	test('a part lists the procedures whose kit, step kit or outputs name it, with role and quantity', async () => {
		const t = await setup();
		const screw = await t.bulk('Screw');
		const jig = await t.bulk('Jig');
		const bracket = await t.bulk('Bracket');
		const p = await t.proc('Fit bracket');
		const s = await t.step(p.id, 'Install');
		await t.ok('POST', `/procedures/${p.id}/kit`, { partId: screw.id, quantity: '2' });
		await t.ok('POST', `/procedures/${p.id}/steps/${s.id}/kit`, { partId: screw.id, quantity: '4', usage: 'consume' });
		await t.ok('POST', `/procedures/${p.id}/steps/${s.id}/kit`, { partId: jig.id, quantity: '1', usage: 'tooling' });
		await t.ok('POST', `/procedures/${p.id}/outputs`, { partId: bracket.id, quantity: '1' });

		const use = await t.ok('GET', `/parts/${screw.id}/procedure-use`);
		expect(use).toHaveLength(2);
		expect(use).toContainEqual(
			expect.objectContaining({ procedureId: p.id, procedureName: 'Fit bracket', scope: 'procedure', role: 'consume', quantity: '2', unitOfMeasure: 'ea', stepTitle: null })
		);
		expect(use).toContainEqual(expect.objectContaining({ scope: 'step', stepTitle: 'Install', quantity: '4' }));
		expect(await t.ok('GET', `/parts/${jig.id}/procedure-use`)).toEqual([
			expect.objectContaining({ role: 'tooling', scope: 'step', stepTitle: 'Install' })
		]);
		expect(await t.ok('GET', `/parts/${bracket.id}/procedure-use`)).toEqual([
			expect.objectContaining({ role: 'output', quantity: '1' })
		]);
	});

	test('a part no procedure names has an empty list, and an unknown part is not found', async () => {
		const t = await setup();
		const lone = await t.bulk('Lone');
		expect(await t.ok('GET', `/parts/${lone.id}/procedure-use`)).toEqual([]);
		expect((await t.call('GET', '/parts/9999/procedure-use')).status).toBe(404);
	});
});

describe('consumption of a part', () => {
	test('consumed stock lists newest first with the work order and the OPAL number', async () => {
		const t = await setup();
		const screw = await t.bulk('Screw');
		const p = await t.proc('Kitted');
		await t.step(p.id, 'Install');
		await t.ok('POST', `/procedures/${p.id}/kit`, { partId: screw.id, quantity: '2' });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const stock = await t.stock(screw.id, '10', 'A1');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: stock.id, quantity: '2' }] });
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: stock.id, quantity: '3' }] });

		const r = await t.ok('GET', `/parts/${screw.id}/consumption`);
		expect(r.total).toBe(2);
		expect(r.items.map((i: { quantity: string }) => i.quantity)).toEqual(['3', '2']);
		expect(r.items[0]).toMatchObject({
			unitOfMeasure: 'ea',
			usage: 'consume',
			opalNumber: stock.opalNumber,
			executionId: e.id,
			woNumber: e.woNumber
		});
		expect((await t.ok('GET', `/parts/${screw.id}/consumption?limit=1`)).items).toHaveLength(1);
	});

	test('a part nothing consumed has an empty list, and an unknown part is not found', async () => {
		const t = await setup();
		const lone = await t.bulk('Lone');
		expect(await t.ok('GET', `/parts/${lone.id}/consumption`)).toEqual({ items: [], total: 0 });
		expect((await t.call('GET', '/parts/9999/consumption')).status).toBe(404);
	});
});
