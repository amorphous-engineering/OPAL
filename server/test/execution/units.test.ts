import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { executionUnit, stockMove } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;

/** A serialized part with one unit on the shelf. */
async function unit(t: T, name: string, serial = '001') {
	const p = await t.part(name);
	const s = await t.stock(p.id, '1', 'SHELF', { serialNumber: serial });
	return { part: p, stock: s };
}

/**
 * An OP procedure: OP 1 "Launch record" names the rocket (required) and the GSE box, OP 2 installs
 * an O-ring into the rocket. Returns the published procedure id.
 */
async function launchOps(t: T, rocketPart: number, gsePart: number, oringPart?: number) {
	const p = await t.proc('Launch ' + Math.random().toString(36).slice(2, 6));
	await t.step(p.id, 'Launch record', {
		dataSchema: { fields: [{ name: 'site', label: 'Site', type: 'text' }] },
		units: [
			{ key: 'rocket', label: 'Rocket', partId: rocketPart, required: true },
			{ key: 'gse', label: 'GSE box', partId: gsePart }
		]
	});
	const fly = await t.step(p.id, 'Fly');
	if (oringPart !== undefined) {
		await t.ok('POST', `/procedures/${p.id}/steps/${fly.id}/kit`, { partId: oringPart, quantity: '2', into: 'rocket' });
	}
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return p.id as number;
}

const bind = async (t: T, e: number, number: string, body: Record<string, unknown>) =>
	t.call('POST', `/executions/${e}/steps/${await t.stepOf(e, number)}/units`, body);

describe('declaring units on a procedure', () => {
	test('an OP declares unit slots; the draft and the published version carry them and the install line', async () => {
		const t = await setup();
		const rocket = await t.part('Rocket');
		const gse = await t.part('GSE box');
		const oring = await t.bulk('O-ring');
		const pid = await launchOps(t, rocket.id, gse.id, oring.id);
		const draft = await t.ok('GET', `/procedures/${pid}/draft`);
		expect(draft.steps[0].units.map((u: any) => u.key)).toEqual(['rocket', 'gse']);
		expect(draft.steps[1].kit[0].into).toBe('rocket');
		const proc = await t.ok('GET', `/procedures/${pid}`);
		expect(proc.unpublishedChanges).toBe(false);
		const v = await t.ok('GET', `/procedures/versions/${proc.currentVersionId}`);
		expect(v.snapshot.steps[0].units[0]).toMatchObject({ key: 'rocket', label: 'Rocket', required: true });
		expect(v.snapshot.steps[1].kit[0].into).toBe('rocket');
	});

	test('a slot names one unit: a sub-step, a repeated key and a bulk part are refused', async () => {
		const t = await setup();
		const rocket = await t.part('Rocket');
		const tape = await t.bulk('Tape');
		const p = await t.proc('Slots');
		const op = await t.step(p.id, 'Record', { units: [{ key: 'rocket', label: 'Rocket', partId: rocket.id }] });
		const sub = await t.step(p.id, 'sub', { parentId: op.id });
		const onSub = await t.call('PATCH', `/procedures/${p.id}/steps/${sub.id}`, { units: [{ key: 'x', label: 'X', partId: rocket.id }] });
		expect(onSub.status).toBe(422);
		const op2 = await t.step(p.id, 'Other');
		const dup = await t.call('PATCH', `/procedures/${p.id}/steps/${op2.id}`, { units: [{ key: 'rocket', label: 'Again', partId: rocket.id }] });
		expect(dup.status).toBe(422);
		const bulkSlot = await t.call('PATCH', `/procedures/${p.id}/steps/${op2.id}`, { units: [{ key: 'tape', label: 'Tape', partId: tape.id }] });
		expect(bulkSlot.status).toBe(422);
	});

	test('a kit line installs only into a declared slot, and only what it consumes', async () => {
		const t = await setup();
		const rocket = await t.part('Rocket');
		const oring = await t.bulk('O-ring');
		const p = await t.proc('Into');
		const op = await t.step(p.id, 'Record', { units: [{ key: 'rocket', label: 'Rocket', partId: rocket.id }] });
		const unknown = await t.call('POST', `/procedures/${p.id}/steps/${op.id}/kit`, { partId: oring.id, quantity: '1', into: 'nose' });
		expect(unknown.status).toBe(422);
		const tooling = await t.call('POST', `/procedures/${p.id}/steps/${op.id}/kit`, { partId: oring.id, quantity: '1', usage: 'tooling', into: 'rocket' });
		expect(tooling.status).toBe(422);
	});

	test('publishing refuses slots on a build, a line into a removed slot, and a slot part listed as tooling', async () => {
		const t = await setup();
		const rocket = await t.part('Rocket');
		const oring = await t.bulk('O-ring');
		const build = await t.proc('Build', { procedureType: 'build' });
		await t.step(build.id, 'Record', { units: [{ key: 'rocket', label: 'Rocket', partId: rocket.id }] });
		expect((await t.call('POST', `/procedures/${build.id}/publish`, {})).status).toBe(409);

		const p = await t.proc('Gone');
		const op = await t.step(p.id, 'Record', { units: [{ key: 'rocket', label: 'Rocket', partId: rocket.id }] });
		await t.ok('POST', `/procedures/${p.id}/steps/${op.id}/kit`, { partId: oring.id, quantity: '1', into: 'rocket' });
		await t.ok('PATCH', `/procedures/${p.id}/steps/${op.id}`, { units: null });
		expect((await t.call('POST', `/procedures/${p.id}/publish`, {})).status).toBe(409);

		const q = await t.proc('Twice');
		const op2 = await t.step(q.id, 'Record', { units: [{ key: 'rocket', label: 'Rocket', partId: rocket.id }] });
		await t.ok('POST', `/procedures/${q.id}/steps/${op2.id}/kit`, { partId: rocket.id, quantity: '1', usage: 'tooling' });
		expect((await t.call('POST', `/procedures/${q.id}/publish`, {})).status).toBe(409);
	});

	test('restoring a version puts the slots and install lines back', async () => {
		const t = await setup();
		const rocket = await t.part('Rocket');
		const gse = await t.part('GSE');
		const oring = await t.bulk('O-ring');
		const pid = await launchOps(t, rocket.id, gse.id, oring.id);
		const proc = await t.ok('GET', `/procedures/${pid}`);
		const op = (await t.draft(pid))[0];
		await t.ok('PATCH', `/procedures/${pid}/steps/${op.id}`, { units: [] });
		await t.ok('POST', `/procedures/${pid}/versions/${proc.currentVersionId}/restore`, {});
		const back = await t.draft(pid);
		expect(back[0].units.map((u: any) => u.key)).toEqual(['rocket', 'gse']);
		expect(back[1].kit[0].into).toBe('rocket');
		expect((await t.ok('GET', `/procedures/${pid}`)).unpublishedChanges).toBe(false);
	});
});

describe('naming the units a work order acts on', () => {
	test('a required slot stops its OP until a unit of that part is named', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await unit(t, 'GSE box');
		const pid = await launchOps(t, r.part.id, g.part.id);
		const e = await t.cut(pid);
		const blocked = await t.complete(e.id, '1', { dataCaptured: { site: 'FAR' } });
		expect(blocked.status).toBe(409);
		expect(blocked.text).toContain('Name the Rocket');
		const doc = await t.doc(e.id);
		expect(doc.ops[0].step.completeBlockers.map((b: any) => b.kind)).toContain('units');

		expect((await bind(t, e.id, '1', { slot: 'rocket', stockId: g.stock.id })).status).toBe(422);
		const named = await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		expect(named.status).toBe(200);
		expect(named.json).toMatchObject({ slot: 'rocket', slotLabel: 'Rocket', opalNumber: r.stock.opalNumber, pencil: true });
		expect((await t.complete(e.id, '1', { dataCaptured: { site: 'FAR' } })).status).toBe(200);
	});

	test('an OP whose sub-steps are done completes once its required unit is named', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const p = await t.proc('Prep');
		const op = await t.step(p.id, 'Prepare', { units: [{ key: 'rocket', label: 'Rocket', partId: r.part.id, required: true }] });
		await t.step(p.id, 'Load fuel', { parentId: op.id });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.complete(e.id, '1.1');
		expect((await t.get(e.id)).status).toBe('in_work');
		await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		expect((await t.get(e.id)).status).toBe('completed');
		const detail = await t.ok('GET', `/inventory/opal/${r.stock.opalNumber}/detail`);
		expect(detail.uses[0].count).toBe(1);
	});

	test('borrowed gear is a text line: no stock record, and it fills a slot', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const pid = await launchOps(t, r.part.id, g.id);
		const e = await t.cut(pid);
		const both = await bind(t, e.id, '1', { slot: 'gse', stockId: r.stock.id, borrowed: { name: 'GSE box' } });
		expect(both.status).toBe(422);
		const lent = await bind(t, e.id, '1', { slot: 'gse', borrowed: { name: 'FAR GSE box', serial: 'G-7', lentBy: 'FAR' } });
		expect(lent.status).toBe(200);
		expect(lent.json).toMatchObject({ stockId: null, borrowed: { name: 'FAR GSE box', serial: 'G-7', lentBy: 'FAR' } });
		const list = await t.ok('GET', `/executions/${e.id}/units`);
		expect(list.units).toHaveLength(1);
	});

	test('hardware the procedure did not list can be named as well, once per work order', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const cam = await unit(t, 'Camera');
		const pid = await launchOps(t, r.part.id, g.id);
		const e = await t.cut(pid);
		expect((await bind(t, e.id, '1', { stockId: cam.stock.id })).status).toBe(200);
		expect((await bind(t, e.id, '1', { stockId: cam.stock.id })).status).toBe(409);
		const doc = await t.doc(e.id);
		expect(doc.ops[0].step.extraUnits[0].opalNumber).toBe(cam.stock.opalNumber);
		expect(doc.units).toHaveLength(1);
	});

	test('a named unit is pencil while its OP is workable and pen once the OP completes', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await unit(t, 'GSE box');
		const pid = await launchOps(t, r.part.id, g.part.id);
		const e = await t.cut(pid);
		const first = await bind(t, e.id, '1', { slot: 'gse', stockId: g.stock.id });
		expect((await t.call('DELETE', `/executions/${e.id}/units/${first.json.id}`)).status).toBe(200);
		const rocket = await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		await t.complete(e.id, '1');
		expect((await t.call('DELETE', `/executions/${e.id}/units/${rocket.json.id}`)).status).toBe(409);
		expect((await bind(t, e.id, '1', { slot: 'gse', stockId: g.stock.id })).status).toBe(409);
		const list = await t.ok('GET', `/executions/${e.id}/units`);
		expect(list.units.map((u: any) => [u.slot, u.pencil])).toEqual([['rocket', false]]);
	});

	test('a unit that is neither on the shelf nor installed cannot be named', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		await t.ok('POST', `/inventory/${r.stock.id}/adjust`, { adjustment: '-1', reason: 'scrap', notes: 'crashed' });
		const pid = await launchOps(t, r.part.id, g.id);
		const e = await t.cut(pid);
		expect((await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id })).status).toBe(409);
	});
});

describe('use counts', () => {
	test('each completed work order that named a unit counts one use of its procedure; void and closed short do not', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const pid = await launchOps(t, r.part.id, g.id);
		for (let n = 0; n < 2; n++) {
			const e = await t.cut(pid);
			await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
			await t.complete(e.id, '1');
			await t.complete(e.id, '2');
		}
		const voided = await t.cut(pid);
		await bind(t, voided.id, '1', { slot: 'rocket', stockId: r.stock.id });
		await t.ok('POST', `/executions/${voided.id}/void`, { reason: 'weather' });
		const detail = await t.ok('GET', `/inventory/opal/${r.stock.opalNumber}/detail`);
		expect(detail.uses).toHaveLength(1);
		expect(detail.uses[0]).toMatchObject({ procedureId: pid, count: 2 });
		expect(detail.workOrders.map((w: any) => [w.status, w.counted, w.slotLabel])).toEqual([
			['completed', true, 'Rocket'],
			['completed', true, 'Rocket'],
			['void', false, 'Rocket']
		]);
	});

	test('a component counts the uses of the assembly it was in, and a replacement starts its count again', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const oring = await t.bulk('O-ring');
		const lot = await t.stock(oring.id, '10', 'BIN');
		const pid = await launchOps(t, r.part.id, g.id, oring.id);
		const run = async () => {
			const e = await t.cut(pid);
			await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
			await t.complete(e.id, '1');
			return e.id as number;
		};
		// First run installs two O-rings, then completes.
		const e1 = await run();
		const fly = await t.stepOf(e1, '2');
		await t.ok('POST', `/executions/${e1}/steps/${fly}/consume`, { items: [{ stockId: lot.id, quantity: '2', into: 'rocket' }] });
		await t.complete(e1, '2');
		const e2 = await run();
		await t.complete(e2, '2');
		let detail = await t.ok('GET', `/inventory/opal/${r.stock.opalNumber}/detail`);
		expect(detail.components[0]).toMatchObject({ opalNumber: lot.opalNumber, qtyUsed: '2', qtyRemoved: '0' });
		expect(detail.components[0].usesSinceInstalled[0].count).toBe(2);
		// The O-ring lot itself carries the rocket's uses while it is inside.
		const lotDetail = await t.ok('GET', `/inventory/opal/${lot.opalNumber}/detail`);
		expect(lotDetail.workOrders.map((w: any) => w.viaOpal)).toEqual([r.stock.opalNumber, r.stock.opalNumber]);

		// Third run takes the two out and puts two new ones in.
		const e3 = await run();
		const unitId = (await t.ok('GET', `/executions/${e3}/units`)).units[0].id;
		const f3 = await t.stepOf(e3, '2');
		await t.ok('POST', `/executions/${e3}/steps/${f3}/removals`, { unitId, stockId: lot.id, quantity: '2', notes: '3 firings' });
		await t.ok('POST', `/executions/${e3}/steps/${f3}/consume`, { items: [{ stockId: lot.id, quantity: '2', into: 'rocket' }] });
		await t.complete(e3, '2');
		detail = await t.ok('GET', `/inventory/opal/${r.stock.opalNumber}/detail`);
		expect(detail.components[0]).toMatchObject({ qtyUsed: '4', qtyRemoved: '2' });
		expect(detail.components[0].removedWoNumber).toBeTruthy();
		expect(detail.components[0].usesSinceInstalled[0].count).toBe(1);
		expect(detail.uses[0].count).toBe(3);
	});
});

describe('work on a unit that already exists', () => {
	test('consuming a line into a slot records the part in that unit; the slot must be named first', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const oring = await t.bulk('O-ring');
		const lot = await t.stock(oring.id, '10', 'BIN');
		const pid = await launchOps(t, r.part.id, g.id, oring.id);
		const e = await t.cut(pid);
		const fly = await t.stepOf(e.id, '2');
		const early = await t.call('POST', `/executions/${e.id}/steps/${fly}/consume`, { items: [{ stockId: lot.id, quantity: '2', into: 'rocket' }] });
		expect(early.status).toBe(409);
		expect(early.text).toContain('Name the Rocket');
		await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		await t.ok('POST', `/executions/${e.id}/steps/${fly}/consume`, { items: [{ stockId: lot.id, quantity: '2', into: 'rocket' }] });
		const moves = t.db.select().from(stockMove).where(eq(stockMove.executionId, e.id)).all();
		expect(moves[0]!.intoStockId).toBe(r.stock.id);
		const installed = await t.ok('GET', `/executions/${e.id}/units/${(await t.ok('GET', `/executions/${e.id}/units`)).units[0].id}/components`);
		expect(installed[0]).toMatchObject({ opalNumber: lot.opalNumber, quantity: '2', serialized: false });
	});

	test('a removed serialized component goes back to stock under its own OPAL number', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const bay = await unit(t, 'Avionics bay', 'B1');
		const pid = await launchOps(t, r.part.id, g.id);
		const e = await t.cut(pid);
		const named = await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		const s1 = await t.stepOf(e.id, '1');
		await t.ok('POST', `/executions/${e.id}/steps/${s1}/consume`, { items: [{ stockId: bay.stock.id, quantity: '1', into: 'rocket' }] });
		expect((await t.ok('GET', `/inventory/${bay.stock.id}`)).balance).toBe('0');
		const removed = await t.ok('POST', `/executions/${e.id}/steps/${s1}/removals`, {
			unitId: named.json.id,
			stockId: bay.stock.id,
			quantity: '1',
			location: 'BENCH'
		});
		expect(removed).toMatchObject({ disposition: 'stock', location: 'BENCH', assemblyOpal: r.stock.opalNumber });
		const back = await t.ok('GET', `/inventory/${bay.stock.id}`);
		expect(back).toMatchObject({ balance: '1', location: 'BENCH', opalNumber: bay.stock.opalNumber });
		const again = await t.call('POST', `/executions/${e.id}/steps/${s1}/removals`, { unitId: named.json.id, stockId: bay.stock.id, quantity: '1' });
		expect(again.status).toBe(409);
		// The naming carries the material record: it can no longer be taken back.
		expect((await t.call('DELETE', `/executions/${e.id}/units/${named.json.id}`)).status).toBe(409);
	});

	test('lot and bulk parts are scrapped on removal, never put back', async () => {
		const t = await setup();
		const r = await unit(t, 'Rocket');
		const g = await t.part('GSE box');
		const oring = await t.bulk('O-ring');
		const lot = await t.stock(oring.id, '10', 'BIN');
		const pid = await launchOps(t, r.part.id, g.id, oring.id);
		const e = await t.cut(pid);
		const named = await bind(t, e.id, '1', { slot: 'rocket', stockId: r.stock.id });
		const fly = await t.stepOf(e.id, '2');
		await t.ok('POST', `/executions/${e.id}/steps/${fly}/consume`, { items: [{ stockId: lot.id, quantity: '2', into: 'rocket' }] });
		const back = await t.call('POST', `/executions/${e.id}/steps/${fly}/removals`, { unitId: named.json.id, stockId: lot.id, quantity: '1', location: 'BIN' });
		expect(back.status).toBe(422);
		const scrap = await t.ok('POST', `/executions/${e.id}/steps/${fly}/removals`, { unitId: named.json.id, stockId: lot.id, quantity: '1' });
		expect(scrap).toMatchObject({ disposition: 'scrap', quantity: '1' });
		expect((await t.ok('GET', `/inventory/${lot.id}`)).balance).toBe('8');
		const e1 = (await t.ok('GET', `/executions/${e.id}`)).status;
		expect(e1).toBe('in_work');
	});

	test('a part installed into borrowed gear is used up, with no record of where it went', async () => {
		const t = await setup();
		const r = await t.part('Rocket');
		const g = await t.part('GSE box');
		const oring = await t.bulk('O-ring');
		const lot = await t.stock(oring.id, '10', 'BIN');
		const pid = await launchOps(t, r.id, g.id, oring.id);
		const e = await t.cut(pid);
		await bind(t, e.id, '1', { slot: 'rocket', borrowed: { name: 'Loaner' } });
		const fly = await t.stepOf(e.id, '2');
		await t.ok('POST', `/executions/${e.id}/steps/${fly}/consume`, { items: [{ stockId: lot.id, quantity: '1', into: 'rocket' }] });
		expect((await t.ok('GET', `/inventory/${lot.id}`)).balance).toBe('9');
		const moves = t.db.select().from(stockMove).where(eq(stockMove.executionId, e.id)).all();
		expect(moves[0]!.intoStockId).toBeNull();
		expect(t.db.select().from(executionUnit).all()).toHaveLength(1);
	});
});
