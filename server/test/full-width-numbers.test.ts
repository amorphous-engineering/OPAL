import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { numberCodec } from '@opal/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { importLegacy, openSchemaImportDb } from '../src/import/index.ts';
import { openSchemaDb } from '../src/db/dev-schema.ts';
import { storeNumbersAtFullWidth } from '../src/db/full-width-numbers.ts';
import { canonicalInput } from '../src/numbers.ts';
import { GOOD } from './requirements/helpers.ts';
import { setup as riskSetup } from './risks/helpers.ts';

const ORG = {
	name: 'Sphinx',
	description: '',
	tiers: [{ level: 1, name: 'Flight', code: 'F' }],
	partNumbering: { prefix: 'SPX', separator: '-', sequenceDigits: 4, format: '{prefix}{sep}{tier_code}{sep}{sequence}' },
	categories: []
};

const sql = (db: { $client: Database }, q: string, ...args: any[]) => db.$client.query(q).all(...args) as any[];

/** Put a column back to the width 1.x and older databases stored it at. */
function age(db: { $client: Database }, table: string, column: string, width: number) {
	for (const r of sql(db, `SELECT id, ${column} AS v FROM ${table}`)) {
		if (typeof r.v !== 'string') continue;
		const v = r.v.replace(/\d{10}$/, (m: string) => String(Number(m)).padStart(width, '0'));
		db.$client.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(v, r.id);
	}
}

async function world() {
	const t = await riskSetup();
	const ok = async (method: string, path: string, body?: unknown) => {
		const r = await t.call(method, path, body);
		if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
		return r.body;
	};
	await ok('POST', '/settings/organization', ORG);
	const p = await ok('POST', '/parts', { name: 'Flange', tier: 1, trackingType: 'bulk' });
	await ok('POST', `/parts/${p.id}/activate`, { cause: 'test' });
	await ok('POST', '/inventory', { partId: p.id, quantity: '5', location: 'A1', enforceTierRules: false });
	const proc = await ok('POST', '/procedures', { projectId: t.project.id, name: 'Weld' });
	await ok('POST', `/procedures/${proc.id}/steps`, { title: 'Prep' });
	await ok('POST', `/procedures/${proc.id}/publish`, {});
	await ok('POST', '/executions', { procedureId: proc.id });
	await t.mkIssue();
	const risk = await t.mk();
	await ok('POST', `/risks/${risk.id}/references`, { type: 'opal', value: 'OPAL-1' });
	await ok('POST', '/requirements', { projectId: t.project.id, title: 'Pressure', statement: GOOD, rationale: 'Sized from the delta-v budget.', verificationMethod: 'test' });
	await ok('POST', '/purchases', { supplierName: 'Acme' });
	return { ...t, ok, part: p };
}

describe('the full-width rewrite', () => {
	test('numbers stored at an old width become full width once, with counters and snapshots', async () => {
		const w = await world();
		const { db } = w;
		// Take the database back to how a 1.x or earlier 2.x database holds these numbers.
		age(db, 'stock_record', 'opal_number', 5);
		sql(db, "UPDATE stock_record SET opal_number = 'OPAL-00186', lot_number = 'WO-00004', source_type = 'production' WHERE id = 1");
		const typedLot = db.$client.query("INSERT INTO stock_record (part_id, opal_number, lot_number, source_type, location, created_at, updated_at) SELECT part_id, 'OPAL-00187', 'T-5', 'manual', location, created_at, updated_at FROM stock_record WHERE id = 1").run();
		expect(typedLot.changes).toBe(1);
		age(db, 'execution', 'wo_number', 5);
		sql(db, "UPDATE execution SET wo_number = 'WO-00004'");
		age(db, 'issue', 'issue_number', 5);
		age(db, 'risk', 'risk_number', 5);
		age(db, 'risk_reference', 'reference_value', 5);
		age(db, 'requirement', 'req_number', 4);
		age(db, 'procedure', 'template_number', 4);
		age(db, 'purchase', 'reference', 4);
		age(db, 'part', 'internal_pn', 4);
		db.$client.query("INSERT INTO designator_sequence (prefix, last_value) VALUES ('SN-SPX-F-0000000001', 2)").run();
		db.$client.query("UPDATE designator_sequence SET prefix = 'SN-SPX-F-0001' WHERE prefix = 'SN-SPX-F-0000000001'").run();
		const snapshot = JSON.stringify({ templateNumber: 'T-0003', steps: [{ kit: [{ partNumber: 'SPX-F-0132', internalPn: 'SPX-F-0001' }] }] });
		db.$client.query('UPDATE procedure_version SET content = ?').run(snapshot);
		db.$client.query("DELETE FROM app_setting WHERE key = 'numbers_full_width'").run();

		expect(sql(db, 'SELECT internal_pn AS v FROM part')[0].v).toBe('SPX-F-0001');
		createApp({ db });

		const one = (q: string) => sql(db, q)[0].v;
		expect(one('SELECT opal_number AS v FROM stock_record WHERE id = 1')).toBe('OPAL-0000000186');
		expect(one('SELECT lot_number AS v FROM stock_record WHERE id = 1')).toBe('WO-0000000004');
		expect(one("SELECT lot_number AS v FROM stock_record WHERE opal_number = 'OPAL-0000000187'")).toBe('T-5');
		expect(one('SELECT wo_number AS v FROM execution')).toBe('WO-0000000004');
		expect(one('SELECT issue_number AS v FROM issue')).toBe('IT-0000000001');
		expect(one('SELECT risk_number AS v FROM risk')).toBe('RISK-0000000001');
		expect(one('SELECT reference_value AS v FROM risk_reference')).toBe('OPAL-0000000001');
		expect(one('SELECT req_number AS v FROM requirement')).toBe('REQ-0000000001');
		expect(one('SELECT template_number AS v FROM procedure')).toBe('T-0000000001');
		expect(one('SELECT reference AS v FROM purchase')).toBe('PO-0000000001');
		expect(one('SELECT internal_pn AS v FROM part')).toBe('SPX-F-0000000001');
		expect(sql(db, "SELECT last_value AS v FROM designator_sequence WHERE prefix = 'SN-SPX-F-0000000001'")[0].v).toBe(2);
		expect(sql(db, "SELECT 1 AS v FROM designator_sequence WHERE prefix = 'SN-SPX-F-0001'")).toEqual([]);
		expect(JSON.parse(one('SELECT content AS v FROM procedure_version'))).toEqual({
			templateNumber: 'T-0000000003',
			steps: [{ kit: [{ partNumber: 'SPX-F-0000000132', internalPn: 'SPX-F-0000000001' }] }]
		});
		expect(one("SELECT value AS v FROM app_setting WHERE key = 'numbers_full_width'")).toBe('1');

		// A second run changes nothing, even when the marker is gone.
		const dump = () => JSON.stringify(['stock_record', 'execution', 'issue', 'risk', 'risk_reference', 'requirement', 'procedure', 'purchase', 'part', 'designator_sequence', 'procedure_version'].map((t) => sql(db, `SELECT * FROM ${t}`)));
		const before = dump();
		createApp({ db });
		storeNumbersAtFullWidth(db, true);
		expect(dump()).toBe(before);

		// The API shows the display width of the setting, and takes any width back.
		const shown = await w.call('GET', '/inventory/opal/OPAL-186/detail');
		expect(shown.status).toBe(200);
		expect(JSON.stringify(shown.body)).toContain('OPAL-0186');
		expect(JSON.stringify(shown.body)).not.toMatch(/\d{10}/);
	});

	test('a legacy import ends at full width and the API shows the display width', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'opal-fw-'));
		try {
			const dest = join(dir, 'new.db');
			await importLegacy(join(import.meta.dir, '../assets/demo-seed.db'), dest, { open: (p) => openSchemaImportDb(p), blobsDir: join(dir, 'b'), avatarsDir: join(dir, 'a') });
			const db = await openSchemaDb(dest);
			const old = sql(db, "SELECT opal_number AS v FROM stock_record WHERE opal_number NOT GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'");
			expect(old.length).toBeGreaterThan(0);
			const app = createApp({ db, resolveActor: () => ({ kind: 'system' }) });
			for (const r of sql(db, 'SELECT opal_number AS v FROM stock_record')) expect(r.v).toMatch(/^OPAL-\d{10}$/);
			for (const r of sql(db, 'SELECT wo_number AS v FROM execution')) expect(r.v).toMatch(/^WO-\d{10}$/);
			for (const r of sql(db, 'SELECT issue_number AS v FROM issue')) expect(r.v).toMatch(/^IT-\d{10}$/);
			const res = await app.request('/api/inventory');
			const text = await res.text();
			expect(text).toMatch(/OPAL-\d{4}\b/);
			expect(text).not.toMatch(/\d{10}/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const text = async (w: Awaited<ReturnType<typeof world>>, path: string) => {
	const res = await w.app.request(`/api${path}`);
	return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
};

describe('numbers leaving the server', () => {
	test('a label shows the display width in its text and its QR address, and the address opens the page', async () => {
		const w = await world();
		const r = await w.call('GET', '/inventory/labels?inventory=OPAL-1,OPAL-0001,OPAL-0000000001,OPAL-77&origin=http://opal.test/');
		expect(r.body.labels).toHaveLength(3);
		for (const l of r.body.labels) {
			expect(l.primary).toBe('OPAL-0001');
			expect(l.secondary).toBe('SPX-F-0001');
			expect(l.url).toBe('http://opal.test/inventory/opal/OPAL-0001');
			expect(l.qrSvg.startsWith('<svg')).toBe(true);
		}
		expect(r.body.failures).toEqual(['OPAL-0077: Stock record not found']);
		// The page route behind the QR address: any width resolves.
		const path = new URL(r.body.labels[0].url).pathname;
		expect((await w.call('GET', `${path}/detail`)).status).toBe(200);
		expect((await w.call('GET', '/inventory/opal/OPAL-0000000001/detail')).status).toBe(200);
	});

	test('CSV exports show every sequence number at the display width', async () => {
		const w = await world();
		const inv = await text(w, '/reports/inventory/csv');
		expect(inv.text).toContain('OPAL-0001');
		expect(inv.text).toContain('SPX-F-0001');
		const wo = await text(w, '/reports/executions/csv');
		expect(wo.text).toContain('WO-0001');
		for (const path of ['/reports/inventory/csv', '/reports/executions/csv', '/reports/parts/csv', '/reports/issues/csv', '/reports/risks/csv']) {
			const r = await text(w, path);
			expect(r.status).toBe(200);
			expect(r.type).toContain('text/csv');
			expect(r.text).not.toMatch(/\d{10}/);
		}
		expect((await text(w, '/reports/issues/csv')).text).toContain('IT-0001');
		expect((await text(w, '/reports/risks/csv')).text).toContain('RISK-0001');
	});

	test('the report ops and the overview show the display width', async () => {
		const w = await world();
		const o = await text(w, '/overview');
		expect(o.status).toBe(200);
		expect(o.text).not.toMatch(/\d{10}/);
	});

	test('search finds a record by its number at any width, a partial number or a part number prefix', async () => {
		const w = await world();
		const hit = async (path: string, q: string) => (await text(w, `${path}?q=${encodeURIComponent(q)}`)).text;
		for (const q of ['WO-0001', 'WO-1', 'WO-00001', 'WO-00', 'wo-']) {
			expect(await hit('/executions', q)).toContain('WO-0001');
		}
		expect(await hit('/executions', 'WO-0002')).not.toContain('WO-0001');
		for (const q of ['OPAL-0001', 'OPAL-1', 'OPAL-000', 'OPAL-00', 'SPX-F-000', 'SPX-F-0001']) {
			expect(await hit('/inventory', q)).toContain('OPAL-0001');
		}
		// A partial number is the start of a shown number: 001 starts OPAL-0010 to OPAL-0019.
		expect(await hit('/inventory', 'OPAL-001')).not.toContain('OPAL-0001');
		expect(await hit('/inventory', 'SPX-F-01')).not.toContain('OPAL-0001');
		for (const q of ['WO-0001', 'WO-4', 'WO-00', 'IT-0001', 'IT-1', 'RISK-0001', 'REQ-0001', 'PO-0001', 'T-0001', 'SPX-F-0001', 'SPX-F-000', 'SPX-F-1']) {
			const r = await text(w, `/search?q=${encodeURIComponent(q)}`);
			expect(r.status).toBe(200);
			if (q === 'WO-4') continue; // no WO-4 exists
			expect(JSON.parse(r.text).length).toBeGreaterThan(0);
			expect(r.text).not.toMatch(/\d{10}/);
		}
	});

	test('changing the sequence digits changes the width in the API at once and moves no stored row', async () => {
		const w = await world();
		expect((await w.call('GET', '/inventory')).body.items[0].opalNumber).toBe('OPAL-0001');
		await w.ok('PUT', '/settings/organization', { ...ORG, partNumbering: { ...ORG.partNumbering, sequenceDigits: 6 } });
		const list = await w.call('GET', '/inventory');
		expect(list.body.items[0].opalNumber).toBe('OPAL-000001');
		expect(list.body.items[0].partInternalPn ?? JSON.stringify(list.body)).toContain('SPX-F-000001');
		expect((await text(w, '/reports/executions/csv')).text).toContain('WO-000001');
		const label = await w.call('GET', '/inventory/labels?inventory=OPAL-000001&origin=http://x');
		expect(label.body.labels[0].url).toBe('http://x/inventory/opal/OPAL-000001');
		expect(sql(w.db, 'SELECT opal_number AS v FROM stock_record')[0].v).toBe('OPAL-0000000001');
		// A number typed without padding finds the record at the new width.
		expect(JSON.stringify((await w.call('GET', '/executions?q=WO-1')).body)).toContain('WO-000001');
	});
});

describe('numbers entering the server', () => {
	test('a __proto__ key in the input stays a field and does not set the prototype', () => {
		const input = JSON.parse('{"__proto__": {"admin": true}, "a": {"__proto__": {"x": 1}}}');
		const out = canonicalInput(input, numberCodec(4)) as Record<string, Record<string, unknown>>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
		expect(Object.hasOwn(out, '__proto__')).toBe(true);
		expect(out.admin).toBeUndefined();
	});
});
