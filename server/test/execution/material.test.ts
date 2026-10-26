import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { stockMove } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function kitted(t: Awaited<ReturnType<typeof setup>>) {
	const screw = await t.bulk('Screw');
	const plate = await t.bulk('Plate');
	const jig = await t.bulk('Jig');
	const p = await t.proc('Kitted');
	const s = await t.step(p.id, 'Install');
	await t.ok('POST', `/procedures/${p.id}/kit`, { partId: screw.id, quantity: '2' });
	await t.ok('POST', `/procedures/${p.id}/steps/${s.id}/kit`, { partId: plate.id, quantity: '1', usage: 'consume' });
	await t.ok('POST', `/procedures/${p.id}/steps/${s.id}/kit`, { partId: jig.id, quantity: '1', usage: 'tooling' });
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return { screw, plate, jig, pid: p.id as number };
}

describe('kit and consumption', () => {
	test('the kit check compares the snapshot kit with stock and lists where to draw from', async () => {
		const t = await setup();
		const { screw, pid } = await kitted(t);
		const e = await t.cut(pid);
		await t.stock(screw.id, '1', 'A1');
		let kit = await t.ok('GET', `/executions/${e.id}/kit`);
		expect(kit.allAvailable).toBe(false);
		expect(kit.items[0]).toMatchObject({ quantityRequired: '2', quantityAvailable: '1', isAvailable: false });
		await t.stock(screw.id, '5', 'B2');
		kit = await t.ok('GET', `/executions/${e.id}/kit`);
		expect(kit.allAvailable).toBe(true);
		expect(kit.items[0].locations.map((l: any) => l.location)).toEqual(['A1', 'B2']);
	});

	test('consuming stock at the procedure level books a consume move linked to the execution', async () => {
		const t = await setup();
		const { screw, pid } = await kitted(t);
		const e = await t.cut(pid);
		const s = await t.stock(screw.id, '10', 'A1');
		const r = await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: s.id, quantity: '2' }] });
		expect(r[0]).toMatchObject({ partName: 'Screw', quantity: '2', location: 'A1' });
		const moves = t.db.select().from(stockMove).where(eq(stockMove.executionId, e.id)).all();
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ kind: 'consume', qty: -20000, stepExecutionId: null });
		expect((await t.ok('GET', `/inventory/${s.id}`)).balance).toBe('8');
		const list = await t.ok('GET', `/executions/${e.id}/consumptions`);
		expect(list[0]).toMatchObject({ partNumber: screw.internalPn, quantity: '2', usage: 'consume', stepId: null });
	});

	test('consuming at a step links the move to the step; tooling is booked as a zero move', async () => {
		const t = await setup();
		const { plate, jig, pid } = await kitted(t);
		const e = await t.cut(pid);
		const sid = await t.stepOf(e.id, '1');
		const ps = await t.stock(plate.id, '3');
		const js = await t.stock(jig.id, '1');
		await t.ok('POST', `/executions/${e.id}/steps/${sid}/consume`, {
			items: [{ stockId: ps.id, quantity: '1' }, { stockId: js.id, quantity: '1', usage: 'tooling' }]
		});
		expect((await t.ok('GET', `/inventory/${ps.id}`)).balance).toBe('2');
		expect((await t.ok('GET', `/inventory/${js.id}`)).balance).toBe('1');
		const at = await t.ok('GET', `/executions/${e.id}/steps/${sid}/consumptions`);
		expect(at.map((c: any) => [c.usage, c.quantity, c.stepNumber])).toEqual([['consume', '1', '1'], ['tooling', '0', '1']]);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.consumptions).toHaveLength(2);
		expect(d.consumptions[0].stepNumber).toBe('1');
		expect((await t.ok('GET', `/executions/${e.id}/state`)).steps[0].consumed).toBe(2);
	});

	test('more than the stock holds is refused and books nothing', async () => {
		const t = await setup();
		const { screw, pid } = await kitted(t);
		const e = await t.cut(pid);
		const s = await t.stock(screw.id, '1');
		const r = await t.call('POST', `/executions/${e.id}/consume`, { items: [{ stockId: s.id, quantity: '2' }] });
		expect(r.status).toBe(409);
		expect(await t.ok('GET', `/executions/${e.id}/consumptions`)).toEqual([]);
		expect((await t.call('POST', `/executions/${e.id}/consume`, { items: [{ stockId: 9999, quantity: '1' }] })).status).toBe(404);
	});

	test('the reconciliation compares kit, step kit and what was consumed, and lists the unplanned', async () => {
		const t = await setup();
		const { screw, plate, pid } = await kitted(t);
		const extra = await t.bulk('Washer');
		const e = await t.cut(pid);
		const sid = await t.stepOf(e.id, '1');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: (await t.stock(screw.id, '5')).id, quantity: '3' }] });
		await t.ok('POST', `/executions/${e.id}/steps/${sid}/consume`, { items: [{ stockId: (await t.stock(plate.id, '5')).id, quantity: '1' }] });
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: (await t.stock(extra.id, '5')).id, quantity: '1' }] });
		const bom = await t.ok('GET', `/executions/${e.id}/bom`);
		expect(bom.kitItems.find((k: any) => k.partId === screw.id)).toMatchObject({ qtyRequired: '2', qtyConsumed: '3', variance: '1' });
		expect(bom.kitItems.find((k: any) => k.partId === plate.id)).toMatchObject({ qtyRequired: '1', qtyConsumed: '1', variance: '0' });
		expect(bom.unplanned).toEqual([expect.objectContaining({ partId: extra.id, qtyConsumed: '1' })]);
		const d = await t.doc(e.id);
		expect(d.kitRelevant).toBe(true);
		expect(d.kit.items).toHaveLength(2);
	});

	test('the document hides material when there is none', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const d = await t.doc(e.id);
		expect(d.kitRelevant).toBe(false);
		expect(d.materialRelevant).toBe(false);
	});
});

describe('production and finalize', () => {
	async function build(t: Awaited<ReturnType<typeof setup>>) {
		const asm = await t.bulk('Assembly');
		const comp = await t.bulk('Component');
		const p = await t.proc('Build it', { procedureType: 'build' });
		await t.step(p.id, 'Assemble');
		await t.ok('POST', `/procedures/${p.id}/outputs`, { partId: asm.id, quantity: '1' });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		return { asm, comp, pid: p.id as number };
	}

	test('the outputs and a produce call create stock linked to the execution', async () => {
		const t = await setup();
		const { asm, pid } = await build(t);
		const e = await t.cut(pid);
		expect((await t.ok('GET', `/executions/${e.id}/outputs`))[0]).toMatchObject({ partId: asm.id, quantity: '1' });
		const made = await t.ok('POST', `/executions/${e.id}/produce`, {
			items: [{ partId: asm.id, quantity: '2', location: 'Dock', lotNumber: 'L1' }]
		});
		expect(made[0]).toMatchObject({ status: 'completed', quantity: '2', location: 'Dock', lotNumber: 'L1' });
		const prods = await t.ok('GET', `/executions/${e.id}/productions`);
		expect(prods.map((x: any) => x.status).sort()).toEqual(['completed', 'planned']);
	});

	test('planned output turns work in progress once the execution starts', async () => {
		const t = await setup();
		const { pid } = await build(t);
		const e = await t.cut(pid);
		await t.complete(e.id, '1').catch(() => null);
		const prods = await t.ok('GET', `/executions/${e.id}/productions`);
		expect(prods[0].status).toBe('wip');
	});

	test('finalize needs a completed execution, books the output at the location and links the components', async () => {
		const t = await setup();
		const { comp, pid } = await build(t);
		const p2 = await t.proc('two steps', { procedureType: 'build' });
		void p2;
		const e = await t.cut(pid);
		const early = await t.call('POST', `/executions/${e.id}/finalize`, { location: 'Dock' });
		expect(early.status).toBe(409);
		const cs = await t.stock(comp.id, '4');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: cs.id, quantity: '2' }] });
		await t.complete(e.id, '1');
		expect((await t.get(e.id)).status).toBe('completed');
		expect((await t.doc(e.id)).canFinalize).toBe(true);
		const f = await t.ok('POST', `/executions/${e.id}/finalize`, { location: 'Dock' });
		expect(f.productions[0]).toMatchObject({ status: 'completed', location: 'Dock', quantity: '1' });
		expect((await t.doc(e.id)).canFinalize).toBe(false);
		const rec = await t.ok('GET', `/inventory/${f.productions[0].stockId}`);
		expect(rec.balance).toBe('1');
		expect(rec.location).toBe('Dock');
		const gen = await t.ok('GET', `/inventory/opal/${f.productions[0].opalNumber}/genealogy`);
		expect(JSON.stringify(gen)).toContain(comp.internalPn);
		const again = await t.call('POST', `/executions/${e.id}/finalize`, { location: 'Dock' });
		expect(again.status).toBe(409);
	});
});

describe('material on closed work orders', () => {
	test('a completed or aborted work order refuses consumption and production with 409', async () => {
		const t = await setup();
		const screw = await t.bulk('Screw');
		const pid = await t.published(['A']);
		const done = await t.cut(pid);
		const sid = await t.stepOf(done.id, '1');
		const stock = await t.stock(screw.id, '10');
		await t.complete(done.id, '1');
		expect((await t.get(done.id)).status).toBe('completed');
		const item = { stockId: stock.id, quantity: '1' };
		for (const r of [
			await t.call('POST', `/executions/${done.id}/consume`, { items: [item] }),
			await t.call('POST', `/executions/${done.id}/steps/${sid}/consume`, { items: [item] }),
			await t.call('POST', `/executions/${done.id}/produce`, { items: [{ partId: screw.id, quantity: '1', location: 'A1' }] })
		]) {
			expect(r.status).toBe(409);
		}
		const aborted = await t.cut(pid);
		await t.ok('POST', `/executions/${aborted.id}/cancel`, { reason: 'scrap' });
		expect((await t.call('POST', `/executions/${aborted.id}/consume`, { items: [item] })).status).toBe(409);
		expect((await t.ok('GET', `/inventory/${stock.id}`)).balance).toBe('10');
	});
});
