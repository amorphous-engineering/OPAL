import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

/** A published procedure that kits and uses a part sold by the metre. */
async function kitted(t: Awaited<ReturnType<typeof setup>>) {
	const wire = await t.ok('POST', '/parts', { name: 'Wire', tier: 3, trackingType: 'bulk', unitOfMeasure: 'm' });
	await t.ok('POST', `/parts/${wire.id}/activate`, { cause: 'test' });
	const p = await t.proc('Wired');
	const s = await t.step(p.id, 'Pull wire');
	await t.ok('POST', `/procedures/${p.id}/kit`, { partId: wire.id, quantity: '5' });
	await t.ok('POST', `/procedures/${p.id}/steps/${s.id}/kit`, { partId: wire.id, quantity: '2', usage: 'consume' });
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return { wire, pid: p.id as number };
}

describe('material on a work order', () => {
	test('every quantity in the document comes with its unit', async () => {
		const t = await setup();
		const { wire, pid } = await kitted(t);
		const e = await t.cut(pid);
		await t.stock(wire.id, '20');
		const d = await t.doc(e.id);
		expect(d.kit.items[0].uom).toBe('m');
		expect(d.ops[0].step.stepKit[0].uom).toBe('m');
		expect((await t.ok('GET', `/executions/${e.id}/kit`)).items[0].uom).toBe('m');
	});

	test('a consumption reports the unit of its part', async () => {
		const t = await setup();
		const { wire, pid } = await kitted(t);
		const e = await t.cut(pid);
		const stock = await t.stock(wire.id, '20');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: stock.id, quantity: '5', usage: 'consume' }] });
		const d = await t.doc(e.id);
		expect(d.consumptions[0]).toMatchObject({ quantity: '5', uom: 'm' });
	});

	test('unplanned consumption reports its unit too', async () => {
		const t = await setup();
		const { pid } = await kitted(t);
		const e = await t.cut(pid);
		const tape = await t.ok('POST', '/parts', { name: 'Tape', tier: 3, trackingType: 'bulk', unitOfMeasure: 'roll' });
		await t.ok('POST', `/parts/${tape.id}/activate`, { cause: 'test' });
		const stock = await t.stock(tape.id, '3');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: stock.id, quantity: '1', usage: 'consume' }] });
		expect((await t.doc(e.id)).kit.unplanned[0]).toMatchObject({ partName: 'Tape', uom: 'roll' });
	});

	test('the source list offers stock on hand, oldest first', async () => {
		const t = await setup();
		const { wire, pid } = await kitted(t);
		const e = await t.cut(pid);
		const oldest = await t.stock(wire.id, '1', 'OLD');
		const empty = await t.stock(wire.id, '1', 'EMPTY');
		const newest = await t.stock(wire.id, '9', 'NEW');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: empty.id, quantity: '1', usage: 'consume' }] });
		const kit = await t.ok('GET', `/executions/${e.id}/kit`);
		expect(kit.items[0].locations.map((l: any) => l.stockId)).toEqual([oldest.id, newest.id]);
	});
});
