import { describe, expect, test } from 'bun:test';
import { parseCsv } from '../../src/services/parts/csv.ts';
import { mergeLegacyBom } from '../../src/services/parts/legacy.ts';
import { setup } from './helpers.ts';

const CSV = (rows: string[]) => rows.join('\n');

describe('csv parsing', () => {
	test('quoted fields, doubled quotes, CRLF and a leading BOM parse', () => {
		const rows = parseCsv('﻿Name,Description\r\n"Bolt, M3","He said ""hi"""\r\nNut,\r\n');
		expect(rows).toEqual([
			['Name', 'Description'],
			['Bolt, M3', 'He said "hi"'],
			['Nut', '']
		]);
	});
});

describe('parts csv import', () => {
	test('preview needs a Name column and some headers', async () => {
		const { api } = await setup();
		expect((await api('POST', '/parts/import/preview', { csv: 'Category,Tier\nx,1' })).status).toBe(400);
	});

	test('preview resolves a blank tier to the lowest tier and maps header aliases', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts/import/preview', {
			csv: CSV(['Part Name,Manufacturer PN,UOM,Tracking,Id,Created At', 'Bolt,MCM-1,ea,BULK,7,2020-01-01'])
		});
		expect(res.status).toBe(200);
		expect(res.json.headersFound).toEqual(['name', 'externalPn', 'unitOfMeasure', 'trackingType']);
		expect(res.json.rows[0]).toMatchObject({
			rowNumber: 1,
			name: 'Bolt',
			externalPn: 'MCM-1',
			tier: 1,
			trackingType: 'bulk',
			valid: true
		});
	});

	test('preview flags a negative reorder point, a bad tier and a bad enum, and counts rows', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts/import/preview', {
			csv: CSV(['Name,Tier,Reorder Point,Procurement,Tracking', 'A,1,-5,,', 'B,9,,,', 'C,1,,steal,', 'D,1,2.5,make,bulk', ',1,,,'])
		});
		expect(res.json.totalRows).toBe(5);
		expect(res.json.validRows).toBe(1);
		expect(res.json.errorRows).toBe(4);
		expect(res.json.rows[0].errors[0]).toContain('negative');
		expect(res.json.rows[1].errors[0]).toContain('Tier must be one of');
		expect(res.json.rows[2].errors[0]).toContain('Procurement');
		expect(res.json.rows[3].reorderPoint).toBe('2.5');
		expect(res.json.rows[4].errors).toContain('Name is required');
	});

	test('preview warns about names and external PNs that exist already', async () => {
		const { api, create } = await setup();
		await create({ name: 'Bolt', externalPn: 'MCM-1' });
		const res = await api('POST', '/parts/import/preview', { csv: CSV(['Name,External PN', 'bolt,x', 'Nut,mcm-1', 'Washer,w']) });
		expect(res.json.warningRows).toBe(2);
		expect(res.json.rows[2].warnings).toEqual([]);
	});

	test('import uses the tier default tracking and the external PN heuristic', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts/import', {
			rows: [
				{ name: 'Flight bracket', tier: 1 },
				{ name: 'Loose screw', tier: 3, externalPn: 'MCM-5' }
			]
		});
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ created: 2, skipped: 0, errors: [], firstPn: 'PN-1-0001', lastPn: 'PN-3-0001' });
		const list = (await api('GET', '/parts?sort=id&dir=asc')).json.items;
		expect(list.map((p: any) => [p.trackingType, p.procurement])).toEqual([
			['serialized', 'make'],
			['bulk', 'buy']
		]);
	});

	test('import honours an explicit procurement', async () => {
		const { api } = await setup();
		await api('POST', '/parts/import', { rows: [{ name: 'X', externalPn: 'E', procurement: 'both' }] });
		expect((await api('GET', '/parts')).json.items[0].procurement).toBe('both');
	});

	test('import skips a duplicate name or external PN, also inside the same file', async () => {
		const { api, create } = await setup();
		await create({ name: 'Existing', externalPn: 'EXT-1' });
		const res = await api('POST', '/parts/import', {
			rows: [{ name: 'existing' }, { name: 'Other', externalPn: 'ext-1' }, { name: 'New' }, { name: 'NEW' }]
		});
		expect(res.json).toMatchObject({ created: 1, skipped: 3 });
	});

	test('a bad row is reported and the other rows still import', async () => {
		const { api, configureProject } = await setup();
		configureProject({ tiers: [{ level: 1, name: 'T', code: 'T' }] });
		const res = await api('POST', '/parts/import', {
			rows: [{ name: 'Good', tier: 1 }, { name: 'Bad tier', tier: 5 }, { name: 'Good 2', tier: 1 }]
		});
		expect(res.json.created).toBe(2);
		expect(res.json.errors).toHaveLength(1);
		expect(res.json.errors[0]).toContain('Row 2');
		expect((await api('GET', '/parts')).json.items).toHaveLength(2);
	});

	test('import refuses more than 5000 rows', async () => {
		const { api } = await setup();
		const rows = Array.from({ length: 5001 }, (_, i) => ({ name: `P${i}` }));
		expect((await api('POST', '/parts/import', { rows })).status).toBe(422);
	});
});

describe('legacy assembly structure', () => {
	const t = '2026-01-01T00:00:00.000Z';
	const ids = new Set([1, 2, 3, 4]);

	test('a parent_id becomes a BOM line with quantity one', () => {
		const { lines, warnings } = mergeLegacyBom(ids, [{ id: 2, parentId: 1, createdAt: t, updatedAt: t }], []);
		expect(warnings).toEqual([]);
		expect(lines).toEqual([{ assemblyId: 1, componentId: 2, quantity: 10000, referenceDesignator: null, notes: null, createdAt: t, updatedAt: t }]);
	});

	test('a legacy bom_lines row keeps its quantity and wins over the parent_id for the same pair', () => {
		const { lines } = mergeLegacyBom(
			ids,
			[{ id: 2, parentId: 1, createdAt: t, updatedAt: t }],
			[{ id: 9, assemblyId: 1, componentId: 2, quantity: 4, referenceDesignator: 'R1', notes: 'n', createdAt: t, updatedAt: t }]
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ quantity: 40000, referenceDesignator: 'R1', notes: 'n' });
	});

	test('a loop, a self reference, a duplicate and a missing part are dropped and reported', () => {
		const { lines, warnings } = mergeLegacyBom(
			ids,
			[
				{ id: 1, parentId: 2, createdAt: t, updatedAt: t },
				{ id: 3, parentId: 3, createdAt: t, updatedAt: t },
				{ id: 4, parentId: 99, createdAt: t, updatedAt: t }
			],
			[
				{ id: 1, assemblyId: 1, componentId: 2, quantity: 1, referenceDesignator: null, notes: null, createdAt: t, updatedAt: t },
				{ id: 2, assemblyId: 1, componentId: 2, quantity: 2, referenceDesignator: null, notes: null, createdAt: t, updatedAt: t }
			]
		);
		expect(lines.map((l) => [l.assemblyId, l.componentId])).toEqual([[1, 2]]);
		expect(warnings).toHaveLength(4);
	});
});
