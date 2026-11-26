/**
 * The part page offers under EDIT what `partFieldLock` leaves open, and `parts.update` refuses with
 * the same rule. These tests send every field the contract takes to an active part and check the
 * server against the rule, so the page and the server cannot drift apart.
 */
import { describe, expect, test } from 'bun:test';
import { PART_FIELDS, partFieldLock, type Part, type PartField } from '@opal/shared';
import { stockRecord } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

const TS = '2026-01-01T00:00:00.000Z';

/** A value for the field that differs from the part's current one. */
function changed(f: PartField, p: Part): unknown {
	switch (f) {
		case 'name': return `${p.name} renamed`;
		case 'tier': return p.tier + 1;
		case 'unitOfMeasure': return p.unitOfMeasure === 'kg' ? 'm' : 'kg';
		case 'trackingType': return p.trackingType === 'bulk' ? 'serialized' : 'bulk';
		case 'lotRule': return p.lotRule === 'required' ? 'none' : 'required';
		case 'procurement': return p.procurement === 'buy' ? 'make' : 'buy';
		case 'externalPn': return 'VEND-77';
		case 'category': return 'Fasteners';
		case 'description': return 'Changed description';
		case 'reorderPoint': return '7';
		case 'isTooling': return !p.isTooling;
		case 'calibrationIntervalDays': return (p.calibrationIntervalDays ?? 0) + 30;
		case 'metadata': return { drawing: 'D-1' };
	}
}

/** Patch every field in turn and check each answer against the rule; return the refused fields. */
async function sendEveryField(s: Awaited<ReturnType<typeof setup>>, id: number): Promise<PartField[]> {
	const refused: PartField[] = [];
	for (const f of PART_FIELDS) {
		const d = (await s.api('GET', `/parts/${id}/detail`)).json;
		const value = changed(f, d.part);
		const res = await s.api('PATCH', `/parts/${id}`, { [f]: value });
		const lock = partFieldLock(d.part.state, f, d);
		if (lock) {
			expect({ f, status: res.status, error: res.json.error }).toEqual({ f, status: 409, error: lock });
			refused.push(f);
		} else {
			expect({ f, status: res.status }).toEqual({ f, status: 200 });
			expect({ f, value: res.json[f] }).toEqual({ f, value });
		}
	}
	return refused;
}

describe('an active part changes what the rule leaves open', () => {
	test('with nothing holding it, everything but the tier changes', async () => {
		const s = await setup();
		const p = await s.create({ name: 'Bracket', trackingType: 'bulk' });
		await s.activate(p.id);
		expect(await sendEveryField(s, p.id)).toEqual(['tier']);
	});

	test('under stock records, the tier, unit and tracking are refused and the rest changes', async () => {
		const s = await setup();
		const p = await s.create({ name: 'Bracket', trackingType: 'bulk' });
		await s.activate(p.id);
		s.db.insert(stockRecord).values({ partId: p.id, opalNumber: 'OPAL-0000000001', location: 'BIN', createdAt: TS, updatedAt: TS }).run();
		expect((await sendEveryField(s, p.id)).sort()).toEqual(['tier', 'trackingType', 'unitOfMeasure']);
	});

	test('named by an assembly with copies, the tier and unit are refused and the rest changes', async () => {
		const s = await setup();
		const asm = await s.create({ name: 'Assembly' });
		const p = await s.create({ name: 'Bracket', trackingType: 'bulk' });
		await s.api('POST', `/parts/${asm.id}/bom`, { componentId: p.id, quantity: '2' });
		await s.activate(p.id);
		await s.activate(asm.id);
		s.db.insert(stockRecord).values({ partId: asm.id, opalNumber: 'OPAL-0000000001', location: 'BIN', createdAt: TS, updatedAt: TS }).run();
		const d = (await s.api('GET', `/parts/${p.id}/detail`)).json;
		expect([d.identityLocked, d.unitLocked, d.trackingLocked]).toEqual([true, true, false]);
		expect((await sendEveryField(s, p.id)).sort()).toEqual(['tier', 'unitOfMeasure']);
	});

	test('the detail reports the tracking lock the update refuses by', async () => {
		const s = await setup();
		const p = await s.create({ name: 'Bracket' });
		expect((await s.api('GET', `/parts/${p.id}/detail`)).json.trackingLocked).toBe(false);
		s.db.insert(stockRecord).values({ partId: p.id, opalNumber: 'OPAL-0000000001', location: 'BIN', createdAt: TS, updatedAt: TS }).run();
		expect((await s.api('GET', `/parts/${p.id}/detail`)).json.trackingLocked).toBe(true);
	});
});
