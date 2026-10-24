import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { importInPlace, importLegacy, LEGACY_HEAD, OLD_VERSION_MESSAGE, openSchemaImportDb } from '../src/import/index.ts';
import { openSchemaDb } from '../src/db/dev-schema.ts';
import { buildDemoContent } from '../src/services/reports/demo.ts';
import { buildLegacyFixture, PNG } from './fixtures/legacy-data.ts';

const SEED = join(import.meta.dir, '../../notes/fixtures/legacy-seed.db');
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-import-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Cells = Record<string, unknown>;
const open = (path: string) => openSchemaImportDb(path);

describe('legacy import of a database with rows in every table', async () => {
	const dir = tmp();
	const src = buildLegacyFixture(dir);
	const before = readFileSync(src);
	const dest = join(dir, 'new.db');
	const report = await importLegacy(src, dest, { open });
	const out = new Database(dest, { readonly: true });
	const q = (s: string) => out.query(s).all() as Cells[];
	const one = (s: string) => q(s)[0] as Cells;

	test('leaves the source file byte-identical', () => {
		expect(readFileSync(src).equals(before)).toBe(true);
	});

	test('keeps ids and copies auth fields verbatim', () => {
		expect(q('SELECT id, username, password_hash, email, oidc_issuer, oidc_subject, is_active, is_admin FROM user ORDER BY id')[0]).toEqual({
			id: 7, username: 'ada', password_hash: 'argon2$hash', email: 'ada@x.test', oidc_issuer: 'https://id.test', oidc_subject: 'sub-1', is_active: 1, is_admin: 1
		});
		expect(q('SELECT id, user_id, token_hash FROM api_token')).toEqual([{ id: 3, user_id: 7, token_hash: 'abc123' }]);
		expect(q('SELECT id FROM part ORDER BY id').map((r) => r.id)).toEqual([10, 11, 12, 13, 14, 15]);
	});

	test('converts timestamps to ISO 8601 milliseconds with Z', () => {
		expect(one('SELECT created_at, updated_at FROM user WHERE id = 7')).toEqual({ created_at: '2026-03-01T10:00:00.123Z', updated_at: '2026-03-02T11:30:00.500Z' });
		expect(one('SELECT activated_at FROM part WHERE id = 10').activated_at).toBe('2026-01-02T03:04:05.678Z');
		expect(one('SELECT tbr_due FROM requirement WHERE id = 2').tbr_due).toBe('2026-12-01T00:00:00.000Z');
	});

	test('quantities are exact integers in Qty units', () => {
		expect(q('SELECT reorder_point FROM part WHERE id IN (10, 12) ORDER BY id').map((r) => r.reorder_point)).toEqual([12345, 1]);
		expect(one('SELECT qty_ordered, unit_cost FROM purchase_line WHERE id = 1')).toEqual({ qty_ordered: 100000, unit_cost: 15000 });
	});

	test('a deleted part becomes obsolete and is listed; a missing part number becomes LEGACY-<id>', () => {
		expect(one('SELECT state, obsoleted_at FROM part WHERE id = 11')).toEqual({ state: 'obsolete', obsoleted_at: '2026-05-05T00:00:00.000Z' });
		expect(report.obsoleteParts).toEqual([{ id: 11, internalPn: 'KT-G-0002' }]);
		expect(one('SELECT internal_pn FROM part WHERE id = 12').internal_pn).toBe('LEGACY-12');
		expect(report.placeholderPns).toEqual([{ id: 12, internalPn: 'LEGACY-12' }]);
	});

	test('part metadata and activation cause are kept; a dangling activator is cleared with a warning', () => {
		expect(one('SELECT metadata, activation_cause FROM part WHERE id = 10')).toEqual({ metadata: '{"color":"red"}', activation_cause: 'first article' });
		expect(one('SELECT activated_by_id FROM part WHERE id = 12').activated_by_id).toBeNull();
		expect(report.warnings).toContain('part 12 activated_by_id: user 55 does not exist, cleared');
	});

	test('bom_lines and part.parent_id merge into bom_line; the bom_lines quantity wins', () => {
		expect(q('SELECT id, assembly_id, component_id, quantity, reference_designator FROM bom_line ORDER BY id')).toEqual([
			{ id: 5, assembly_id: 13, component_id: 10, quantity: 40000, reference_designator: 'R1' },
			{ id: 6, assembly_id: 13, component_id: 14, quantity: 30000, reference_designator: null },
			{ id: 7, assembly_id: 13, component_id: 11, quantity: 10000, reference_designator: null }
		]);
	});

	test('profile fields move to user_profile and an avatar file is copied by hash', () => {
		const p = one('SELECT * FROM user_profile WHERE user_id = 7');
		expect(p).toMatchObject({ job_title: 'Lead', phone: '555-0100', workcenter_id: 1, avatar_hash: sha(PNG), avatar_mime: 'image/png', avatar_source: 'upload', needs_onboarding: 1 });
		expect(existsSync(join(dir, 'avatars', sha(PNG)))).toBe(true);
		const bob = one('SELECT * FROM user_profile WHERE user_id = 8');
		expect(bob).toMatchObject({ avatar_hash: null, workcenter_id: null, needs_profile_setup: 1 });
	});

	test('passkeys copy 1:1; sign-in settings go to auth_setting; the rest stays in app_setting', () => {
		expect(one('SELECT id, user_id, sign_count, name FROM passkey_credential')).toEqual({ id: 4, user_id: 7, sign_count: 9, name: 'Key' });
		expect(q('SELECT key, value FROM auth_setting ORDER BY key')).toEqual([{ key: 'oidc_issuer', value: 'https://id.test' }, { key: 'passkeys_enabled', value: 'false' }]);
		expect(q('SELECT key FROM app_setting ORDER BY key').map((r) => r.key)).toEqual(['project_config', 'some_other_key']);
	});

	test('a deleted role is left out with its grants and gates', () => {
		expect(q('SELECT id, name, key FROM role ORDER BY id')).toEqual([{ id: 1, name: 'Engineer', key: 'engineer' }, { id: 2, name: 'Welder', key: null }]);
		expect(q('SELECT user_id, role_id FROM user_role')).toEqual([{ user_id: 7, role_id: 1 }]);
		expect(q('SELECT gate FROM role_gate').map((r) => r.gate)).toEqual(['issue.disposition']);
	});

	test('one project is made from the project config and holds every scoped record', () => {
		expect(q('SELECT id, code, name, description, state FROM project')).toEqual([{ id: 1, code: 'KESTREL-TEST', name: 'Kestrel Test', description: 'Rocket', state: 'active' }]);
		for (const t of ['risk', 'requirement', 'baseline_event', 'issue', 'procedure', 'execution', 'dataset']) {
			expect(q(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id <> 1`)[0]!.n).toBe(0);
			expect(q(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n).toBeGreaterThan(0);
		}
		expect(JSON.parse(String(one("SELECT value FROM app_setting WHERE key = 'project_config'").value)).name).toBe('Kestrel Test');
	});

	test('suppliers: deleted ones stay as inactive; an unknown part drops the catalog row', () => {
		expect(q('SELECT id, is_active FROM supplier ORDER BY id')).toEqual([{ id: 1, is_active: 0 }, { id: 2, is_active: 1 }]);
		expect(q('SELECT id, lead_time_days FROM supplier_part')).toEqual([{ id: 1, lead_time_days: null }]);
		expect(report.failedRows).toContainEqual({ table: 'supplier_part', id: 2, reason: 'supplier or part is not imported' });
	});

	test('purchases: registered supplier clears the name, free text keeps it, a missing reference is made', () => {
		expect(q('SELECT id, reference, supplier_id, supplier_name, target_date FROM purchase ORDER BY id')).toEqual([
			{ id: 1, reference: 'PO-0001', supplier_id: 2, supplier_name: null, target_date: '2026-04-01' },
			{ id: 2, reference: 'PO-0002', supplier_id: null, supplier_name: 'Walk-in shop', target_date: null }
		]);
	});

	test('purchase expenses: a part makes a receipt, none makes a charge named by its note prefix', () => {
		expect(q('SELECT id, kind, quantity, unit_cost, amount, part_id, purchase_line_id, notes FROM purchase_expense ORDER BY id')).toEqual([
			{ id: 1, kind: 'receipt', quantity: 100000, unit_cost: 15000, amount: null, part_id: 10, purchase_line_id: 1, notes: null },
			{ id: 2, kind: 'shipping', quantity: null, unit_cost: null, amount: 125000, part_id: null, purchase_line_id: null, notes: 'freight' }
		]);
	});

	test('a purchase line with no quantity is a failed row', () => {
		expect(q('SELECT id FROM purchase_line').map((r) => r.id)).toEqual([1]);
		expect(report.failedRows.map((f) => `${f.table} ${f.id}`)).toContain('purchase_line 2');
	});

	test('attachments: files go into the blob store by SHA-256; equal files share a blob', () => {
		expect(q('SELECT id, owner_type, owner_id, kind, blob_sha256 FROM attachment ORDER BY id')).toEqual([
			{ id: 1, owner_type: 'issue', owner_id: 1, kind: 'reference', blob_sha256: sha(PNG) },
			{ id: 2, owner_type: 'procedure_step', owner_id: 101, kind: 'step_image', blob_sha256: expect.any(String) },
			{ id: 3, owner_type: 'procedure', owner_id: 1, kind: 'inline', blob_sha256: expect.any(String) },
			{ id: 5, owner_type: 'purchase', owner_id: 1, kind: 'quote', blob_sha256: expect.any(String) },
			{ id: 7, owner_type: 'step_execution', owner_id: 1, kind: 'capture', blob_sha256: sha(PNG) }
		]);
		expect(q('SELECT COUNT(*) AS n FROM blob')[0]!.n).toBe(5); // a6 (no owner) is stored too
		for (const b of q('SELECT sha256, size_bytes, mime_type FROM blob')) {
			expect(readFileSync(join(dir, 'blobs', String(b.sha256))).byteLength).toBe(b.size_bytes as number);
		}
		expect(report.failedRows).toContainEqual({ table: 'attachment', id: 4, reason: 'file a4-missing.png is missing' });
	});

	test('procedures: status maps, the draft keeps ids, steps get dense positions, sign-offs become the effective list', () => {
		expect(q('SELECT id, template_number, status, current_version_id, procedure_type FROM procedure ORDER BY id')).toEqual([
			{ id: 1, template_number: 'T-0001', status: 'released', current_version_id: 1, procedure_type: 'build' },
			{ id: 2, template_number: 'T-0002', status: 'obsolete', current_version_id: null, procedure_type: 'op' }
		]);
		expect(q('SELECT id, parent_step_id, position, is_contingency, signoffs, strict_sequence, workcenter_id FROM procedure_step ORDER BY id')).toEqual([
			{ id: 100, parent_step_id: null, position: 0, is_contingency: 1 - 1, signoffs: '[{"role":"Engineer"}]', strict_sequence: 0, workcenter_id: 1 },
			{ id: 101, parent_step_id: 100, position: 0, is_contingency: 0, signoffs: '[{"role":"Engineer"},{"role":null}]', strict_sequence: 0, workcenter_id: null },
			{ id: 102, parent_step_id: 100, position: 1, is_contingency: 0, signoffs: '[{"role":null}]', strict_sequence: 0, workcenter_id: null },
			{ id: 103, parent_step_id: null, position: 0, is_contingency: 1, signoffs: '[{"role":null}]', strict_sequence: 1, workcenter_id: null }
		]);
		expect(JSON.parse(String(one('SELECT callouts FROM procedure_step WHERE id = 100').callouts))).toEqual([{ kind: 'caution', text: 'Hot' }]);
	});

	test('step dependencies, kit, step kit and outputs keep their quantities; repeats are failed rows', () => {
		expect(q('SELECT step_id, depends_on_step_id FROM step_dependency')).toEqual([{ step_id: 103, depends_on_step_id: 100 }]);
		expect(q('SELECT id, procedure_id, step_id, part_id, quantity, usage, notes FROM kit_item ORDER BY id')).toEqual([
			{ id: 1, procedure_id: 1, step_id: null, part_id: 10, quantity: 40000, usage: 'consume', notes: null },
			{ id: 3, procedure_id: null, step_id: 102, part_id: 14, quantity: 20000, usage: 'consume', notes: 'loctite' },
			{ id: 4, procedure_id: null, step_id: 102, part_id: 15, quantity: 10000, usage: 'tooling', notes: null }
		]);
		expect(q('SELECT part_id, quantity FROM procedure_output')).toEqual([{ part_id: 13, quantity: 10000 }]);
		expect(report.failedRows.map((f) => `${f.table} ${f.id}`)).toEqual(expect.arrayContaining(['kit 2', 'step_dependency 2', 'step_image 2']));
	});

	test('the step image links the step to its attachment', () => {
		expect(q('SELECT step_id, attachment_id, caption FROM step_image')).toEqual([{ step_id: 101, attachment_id: 2, caption: 'Clean here' }]);
	});

	test('a published version becomes a snapshot: ids kept, images and inline links use blob hashes', () => {
		const v = one('SELECT version_number, change_note, content FROM procedure_version WHERE id = 1');
		expect(v).toMatchObject({ version_number: 1, change_note: 'first' });
		const snap = JSON.parse(String(v.content));
		const blobOf = (id: number) => q(`SELECT blob_sha256 FROM attachment WHERE id = ${id}`)[0]!.blob_sha256;
		expect(snap.schemaVersion).toBe(1);
		expect(snap.procedure).toEqual({ templateNumber: 'T-0001', projectId: 1, name: 'Valve build', description: 'd', procedureType: 'build' });
		expect(snap.steps.map((s: Cells) => [s.id, s.number, s.parentId])).toEqual([[100, '1', null], [101, '1.1', 100], [102, '1.2', 100], [103, 'C1', null]]);
		expect(snap.steps[0].instructions).toBe(`See ![d](/api/blobs/${blobOf(3)})`);
		expect(snap.steps[1].images).toEqual([{ sha256: blobOf(2), filename: 'a2.png', caption: 'Clean here' }]);
		expect(snap.steps[3].dependsOn).toEqual([100]);
		expect(snap.steps[3].callouts).toEqual([{ kind: 'caution', text: 'Careful' }]);
		expect(snap.steps[2].kit.map((k: Cells) => k.usage)).toEqual(['consume', 'tooling']);
		expect(snap.kit).toEqual([{ partId: 10, quantity: '4' }]);
		// the draft keeps the authoring link
		expect(one('SELECT instructions FROM procedure_step WHERE id = 100').instructions).toBe('See ![d](/api/attachments/3/download)');
	});

	test('stock records keep id and OPAL number; serialized parts move the lot to the serial', () => {
		expect(q('SELECT id, opal_number, lot_number, serial_number, source_type, expiration_date FROM stock_record WHERE id IN (1, 5, 9, 11) ORDER BY id')).toEqual([
			{ id: 1, opal_number: 'OPAL-00001', lot_number: 'L1', serial_number: null, source_type: 'purchase', expiration_date: '2027-01-31' },
			{ id: 5, opal_number: 'OPAL-00005', lot_number: 'WO-00001', serial_number: '001', source_type: 'production', expiration_date: null },
			{ id: 9, opal_number: 'OPAL-00012', lot_number: 'S-9', serial_number: null, source_type: 'manual', expiration_date: null },
			{ id: 11, opal_number: 'OPAL-00011', lot_number: null, serial_number: 'SN-77', source_type: 'manual', expiration_date: null }
		]);
		expect(one('SELECT last_calibrated_at, calibration_due_at FROM stock_record WHERE id = 4')).toEqual({ last_calibrated_at: '2026-01-01T00:00:00.000Z', calibration_due_at: '2027-01-01T00:00:00.000Z' });
	});

	test('every stock balance equals the old quantity', () => {
		const old = new Database(src, { readonly: true });
		for (const r of old.query('SELECT id, quantity FROM inventory_record').all() as { id: number; quantity: number }[]) {
			const sum = out.query('SELECT COALESCE(SUM(qty), 0) AS s FROM stock_move WHERE stock_id = ?').get(r.id) as { s: number };
			expect(sum.s).toBe(Math.round(r.quantity * 10000));
		}
		old.close();
	});

	const moves = (stock: number) => q(`SELECT kind, qty, reason, notes, purchase_line_id, execution_id, step_execution_id, into_stock_id FROM stock_move WHERE stock_id = ${stock} ORDER BY id`);

	test('consumption: procedure consume, scrap and adjustment with a reason, cycle count, tooling', () => {
		expect(moves(1)).toEqual([
			{ kind: 'receive', qty: 130000, reason: null, notes: null, purchase_line_id: 1, execution_id: null, step_execution_id: null, into_stock_id: null },
			{ kind: 'consume', qty: -30000, reason: null, notes: null, purchase_line_id: null, execution_id: 1, step_execution_id: 2, into_stock_id: 5 }
		]);
		expect(moves(2).map((m) => [m.kind, m.qty, m.reason, m.notes])).toEqual([
			['receive', 40000, null, null],
			['adjust', -10000, 'damage', 'dropped on floor'],
			['adjust', 20000, 'found', 'behind shelf']
		]);
		expect(moves(3).map((m) => [m.kind, m.qty, m.reason])).toEqual([['receive', 20000, null], ['count', -10000, 'cycle_count'], ['count', 0, 'cycle_count']]);
		expect(moves(4).map((m) => [m.kind, m.qty, m.reason])).toEqual([['receive', 10000, null], ['consume', 0, 'tooling']]);
	});

	test('production: a completed one is a produce move linked to the work order; a planned one makes no move', () => {
		expect(moves(5)).toEqual([{ kind: 'produce', qty: 10000, reason: null, notes: null, purchase_line_id: null, execution_id: 1, step_execution_id: null, into_stock_id: null }]);
		expect(moves(6)).toEqual([]);
		expect(q('SELECT execution_id, stock_id, quantity FROM execution_output ORDER BY id')).toEqual([{ execution_id: 1, stock_id: 5, quantity: 10000 }, { execution_id: 2, stock_id: 6, quantity: 10000 }]);
	});

	test('a completed transfer is two moves that point at each other; a pending one is kept aside', () => {
		const t = q("SELECT id, stock_id, qty, from_location, to_location, from_lot, to_lot, counterpart_id FROM stock_move WHERE kind = 'transfer' ORDER BY id");
		expect(t).toHaveLength(2);
		expect(t[0]).toMatchObject({ stock_id: 7, qty: -60000, from_location: 'SHELF', to_location: 'BIN', to_lot: 'T1', counterpart_id: t[1]!.id });
		expect(t[1]).toMatchObject({ stock_id: 8, qty: 60000, counterpart_id: t[0]!.id });
		expect(q("SELECT reason FROM legacy_row WHERE table_name = 'stock_transfer'")).toEqual([{ reason: 'status pending moves no stock' }]);
	});

	test('a gap between the old quantity and the movements: a purchase or manual surplus is a receive, any other is an import adjustment, and it is listed', () => {
		expect(moves(7)[0]).toMatchObject({ kind: 'receive', qty: 100000 });
		expect(moves(10)).toEqual([expect.objectContaining({ kind: 'adjust', qty: 20000, reason: 'import' })]);
		expect(report.stockDifferences).toEqual([{ stockId: 10, opalNumber: 'OPAL-00010', partId: 10, legacyQuantity: 20000, ledgerSum: 0, difference: 20000, move: 'adjust import' }]);
	});

	test('a record with no OPAL number is given the next one', () => {
		expect(one('SELECT opal_number FROM stock_record WHERE id = 9').opal_number).toBe('OPAL-00012');
	});

	test('test templates and results copy across with scaled limits', () => {
		expect(one('SELECT part_id, min_value, max_value, test_type FROM test_template')).toEqual({ part_id: 10, min_value: 82000, max_value: 99000, test_type: 'numeric' });
		expect(one('SELECT stock_id, template_id, result, value FROM stock_test_result')).toEqual({ stock_id: 1, template_id: 1, result: 'pass', value: '9' });
	});

	test('issues: ids and numbers kept, deleted becomes void, the part becomes a link, execution anchors map', () => {
		expect(q('SELECT id, issue_number, status, execution_id, raised_step_id, containment_step_id, closed_at FROM issue ORDER BY id')).toEqual([
			{ id: 1, issue_number: 'IT-00001', status: 'open', execution_id: 1, raised_step_id: 2, containment_step_id: 2, closed_at: null },
			{ id: 2, issue_number: 'IT-00002', status: 'closed', execution_id: null, raised_step_id: null, containment_step_id: null, closed_at: '2026-03-02T11:30:00.500Z' },
			{ id: 3, issue_number: 'IT-00003', status: 'void', execution_id: null, raised_step_id: null, containment_step_id: null, closed_at: '2026-03-02T11:30:00.500Z' }
		]);
		expect(q('SELECT issue_id, part_id, risk_id, risk_role FROM issue_link ORDER BY id')).toEqual([
			{ issue_id: 2, part_id: null, risk_id: 1, risk_role: 'mitigation' },
			{ issue_id: 1, part_id: 10, risk_id: null, risk_role: null }
		]);
		expect(one('SELECT body, user_id FROM issue_comment')).toEqual({ body: 'Looking', user_id: 7 });
	});

	test('rows with no home in the new schema are kept in legacy_row with the reason', () => {
		expect(q('SELECT table_name, row_id FROM legacy_row ORDER BY id').map((r) => `${r.table_name} ${r.row_id}`)).toEqual(
			expect.arrayContaining(['issue_reference 1', 'part_requirements 3', 'attachment 6', 'stock_transfer 2', 'issue 3'])
		);
		expect(JSON.parse(String(one("SELECT data FROM legacy_row WHERE table_name = 'issue_reference'").data))).toMatchObject({ reference_type: 'opal', reference_value: 'OPAL-00001' });
	});

	test('risks: deleted becomes closed, a probability outside 1..5 is clamped with a warning', () => {
		expect(q('SELECT id, risk_number, disposition, probability, asset_part_id, asset_text, realized_issue_id FROM risk ORDER BY id')).toEqual([
			{ id: 1, risk_number: 'RISK-00001', disposition: 'mitigate', probability: 4, asset_part_id: 10, asset_text: null, realized_issue_id: 1 },
			{ id: 2, risk_number: 'RISK-00002', disposition: 'closed', probability: 5, asset_part_id: null, asset_text: 'the pad', realized_issue_id: null }
		]);
		expect(q('SELECT reference_type, reference_value FROM risk_reference')).toEqual([{ reference_type: 'work_order', reference_value: 'WO-00001' }]);
	});

	test('requirements: revisions keep their rows, deleted becomes cancelled, baselines keep their items', () => {
		expect(q('SELECT id, req_number, revision, lifecycle_state, parent_id, supersedes_id, tbr, tbr_owner_id FROM requirement ORDER BY id')).toEqual([
			{ id: 1, req_number: 'REQ-0001', revision: 1, lifecycle_state: 'baselined', parent_id: null, supersedes_id: null, tbr: 0, tbr_owner_id: null },
			{ id: 2, req_number: 'REQ-0002', revision: 1, lifecycle_state: 'draft', parent_id: 1, supersedes_id: null, tbr: 1, tbr_owner_id: 7 },
			{ id: 3, req_number: 'REQ-0003', revision: 1, lifecycle_state: 'cancelled', parent_id: null, supersedes_id: null, tbr: 0, tbr_owner_id: null },
			{ id: 4, req_number: 'REQ-0001', revision: 2, lifecycle_state: 'preliminary', parent_id: null, supersedes_id: 1, tbr: 0, tbr_owner_id: null }
		]);
		expect(q('SELECT event_id, requirement_id, created_at FROM baseline_event_item')).toEqual([{ event_id: 1, requirement_id: 1, created_at: '2026-03-01T10:00:00.123Z' }]);
	});

	test('part allocations: the foreign key wins, a typed number resolves to the latest revision, the rest is kept aside', () => {
		expect(q('SELECT part_id, requirement_id, status FROM part_requirement ORDER BY id')).toEqual([
			{ part_id: 10, requirement_id: 1, status: 'verified' },
			{ part_id: 14, requirement_id: 2, status: 'open' }
		]);
		expect(q("SELECT row_id FROM legacy_row WHERE table_name = 'part_requirements'")).toEqual([{ row_id: 3 }]);
	});

	test('datasets: deleted becomes archived, points keep their step execution', () => {
		expect(q('SELECT id, state, archived_at, procedure_id FROM dataset ORDER BY id')).toEqual([
			{ id: 1, state: 'active', archived_at: null, procedure_id: 1 },
			{ id: 2, state: 'archived', archived_at: '2026-03-02T11:30:00.500Z', procedure_id: null }
		]);
		expect(one('SELECT dataset_id, "values", step_execution_id, recorded_at FROM data_point')).toEqual({ dataset_id: 1, values: '{"psi":100}', step_execution_id: 2, recorded_at: '2026-04-04T04:04:04.500Z' });
	});

	test('notifications copy across; a kind the new schema does not know is a failed row', () => {
		expect(q('SELECT id, kind, actor_id, read_at FROM notification')).toEqual([{ id: 1, kind: 'issue_assigned', actor_id: 8, read_at: '2026-03-02T11:30:00.500Z' }]);
		expect(report.failedRows).toContainEqual({ table: 'notification', id: 2, reason: 'kind "mystery" is not valid' });
	});

	test('executions: ids and work order numbers kept, priority maps, a missing number is made', () => {
		expect(q('SELECT id, wo_number, status, priority, procedure_id, version_id, created_by_id FROM execution ORDER BY id')).toEqual([
			{ id: 1, wo_number: 'WO-00001', status: 'in_work', priority: 'urgent', procedure_id: 1, version_id: 1, created_by_id: 7 },
			{ id: 2, wo_number: 'WO-00002', status: 'cut', priority: 'normal', procedure_id: 1, version_id: 1, created_by_id: null }
		]);
	});

	test('step executions: snapshot steps by order, statuses reduce to the new four, missing signatures are written', () => {
		expect(q('SELECT id, step_id, adhoc_step_id, status, completed_by_id, workcenter_id FROM step_execution ORDER BY id')).toEqual([
			{ id: 1, step_id: 100, adhoc_step_id: null, status: 'awaiting_signoff', completed_by_id: null, workcenter_id: null },
			{ id: 2, step_id: 101, adhoc_step_id: null, status: 'awaiting_signoff', completed_by_id: 7, workcenter_id: 1 },
			{ id: 3, step_id: 102, adhoc_step_id: null, status: 'completed', completed_by_id: 8, workcenter_id: null },
			{ id: 4, step_id: 103, adhoc_step_id: null, status: 'skipped', completed_by_id: null, workcenter_id: null },
			{ id: 5, step_id: null, adhoc_step_id: 5, status: 'pending', completed_by_id: null, workcenter_id: null },
			{ id: 6, step_id: null, adhoc_step_id: 6, status: 'pending', completed_by_id: null, workcenter_id: null }
		]);
		expect(one('SELECT data_captured FROM step_execution WHERE id = 2').data_captured).toBe('{"torque":12}');
		expect(q('SELECT step_execution_id, slot, label, role, signed_by_id FROM signoff ORDER BY id')).toEqual([
			{ step_execution_id: 2, slot: 0, label: 'Primary buyoff', role: 'Engineer', signed_by_id: 7 },
			{ step_execution_id: 3, slot: 0, label: 'Primary buyoff', role: null, signed_by_id: 7 }
		]);
		expect(one('SELECT body, author_id FROM step_note')).toEqual({ body: 'Looks fine', author_id: 7 });
	});

	test('redlines: a redline OP and its sub-step become adhoc steps that name their host step', () => {
		expect(q('SELECT id, execution_id, issue_id, parent_id, host_step_id, position, number, title, signoffs FROM adhoc_step ORDER BY id')).toEqual([
			{ id: 5, execution_id: 1, issue_id: 1, parent_id: null, host_step_id: 100, position: 0, number: '1R1', title: 'Redo prep', signoffs: '[]' },
			{ id: 6, execution_id: 1, issue_id: 1, parent_id: 5, host_step_id: 100, position: 0, number: '1R1.1', title: 'Wipe', signoffs: '[{"role":null},{"role":null}]' }
		]);
	});

	test('participants come from the participants list and from the step focus', () => {
		expect(q('SELECT execution_id, user_id, joined_at, focus_step_id FROM execution_participant ORDER BY user_id')).toEqual([
			{ execution_id: 1, user_id: 7, joined_at: '2026-03-02T11:00:00.000Z', focus_step_id: null },
			{ execution_id: 1, user_id: 8, joined_at: null, focus_step_id: 6 }
		]);
	});

	test('legacy audit rows go to legacy_audit unchanged', () => {
		expect(q('SELECT id, timestamp, table_name, record_id, action, user_id, old_values, new_values FROM legacy_audit ORDER BY id')).toEqual([
			{ id: 1, timestamp: '2026-03-01 10:00:00.123456', table_name: 'part', record_id: 10, action: 'create', user_id: 7, old_values: null, new_values: '{"name": "Washer"}' },
			{ id: 2, timestamp: '2026-03-02 11:30:00.5', table_name: 'part', record_id: 10, action: 'update', user_id: null, old_values: '{"name": "Washer"}', new_values: '{"name": "Washer 2"}' }
		].map((r) => ({ ...r, old_values: r.old_values === null ? null : JSON.stringify(JSON.parse(r.old_values)), new_values: JSON.stringify(JSON.parse(r.new_values)) })));
	});

	test('designator counters sit at or above the highest number in use', () => {
		const seq = Object.fromEntries(q('SELECT prefix, last_value FROM designator_sequence').map((r) => [r.prefix, r.last_value]));
		expect(seq).toMatchObject({ OPAL: 12, WO: 9, IT: 3, RISK: 2, REQ: 3, T: 2, 'SN-KT-F-0001': 2, 'PN-1': 1, 'PN-2': 4 });
	});

	test('autoincrement counters sit above the highest id of each table', () => {
		const seq = Object.fromEntries(q('SELECT name, seq FROM sqlite_sequence').map((r) => [r.name, r.seq]));
		expect(seq.user).toBeGreaterThanOrEqual(8);
		expect(seq.api_token).toBeGreaterThanOrEqual(3);
		expect(seq.part).toBeGreaterThanOrEqual(15);
		expect(seq.stock_record).toBeGreaterThanOrEqual(11);
		expect(seq.step_execution).toBeGreaterThanOrEqual(6);
		expect(seq.audit_log).toBeGreaterThanOrEqual(q('SELECT MAX(id) AS m FROM audit_log')[0]!.m as number);
		const w = new Database(dest);
		w.run("INSERT INTO user (username, name, created_at, updated_at) VALUES ('n', 'N', 'x', 'x')");
		w.close();
		expect(q('SELECT MAX(id) AS m FROM user')[0]!.m).toBe(9);
	});

	test('skipped tables are listed with their row counts', () => {
		expect(report.notImported.map((t) => [t.table, t.rows]).sort()).toEqual([['auth_session', 1], ['extension', 1], ['onshape_link', 1], ['onshape_sync_log', 1], ['webauthn_challenge', 1]]);
	});

	test('one summary audit row per table', () => {
		const rows = q("SELECT after FROM audit_log WHERE entity = 'import' AND op = 'legacy.import'").map((r) => JSON.parse(String(r.after)));
		expect(rows.find((r) => r.table === 'part')).toEqual({ table: 'part', rows: 6, read: 6 });
		expect(rows.length).toBe(Object.keys(report.tables).length + Object.keys(report.derived).length);
	});

	test('no foreign key points at a missing row', () => {
		expect(q('PRAGMA foreign_key_check')).toEqual([]);
		expect(q('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
	});

	test('every legacy table is imported or skipped', () => {
		const src2 = new Database(src, { readonly: true });
		const tables = (src2.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name).filter((n) => n !== 'alembic_version' && !n.includes('_fts'));
		src2.close();
		const covered = new Set([...Object.keys(report.tables), ...report.notImported.map((t) => t.table)]);
		expect(tables.filter((t) => !covered.has(t))).toEqual([]);
	});

	test('the row counts of the report match the tables', () => {
		const count = (t: string) => q(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n as number;
		expect(report.tables.part!.imported).toBe(count('part'));
		expect(report.tables.inventory_record!.imported).toBe(count('stock_record'));
		expect(report.tables.step_execution!.imported).toBe(count('step_execution'));
		expect(report.derived.stock_move).toBe(count('stock_move'));
	});

	test('refuses a wrong alembic version', async () => {
		const d = tmp();
		const old = buildLegacyFixture(d, { version: 'deadbeef0000' });
		await expect(importLegacy(old, join(d, 'x.db'), { open })).rejects.toThrow(OLD_VERSION_MESSAGE);
	});

	test('refuses an existing destination', async () => {
		await expect(importLegacy(src, dest, { open })).rejects.toThrow('already exists');
	});
});

describe('importInPlace', () => {
	test('renames the old file, leaves it byte-identical, writes the reports', async () => {
		const d = tmp();
		const p = buildLegacyFixture(d);
		const before = readFileSync(p);
		const report = await importInPlace(p, { open });
		expect(report?.tables.part!.imported).toBe(6);
		expect(readFileSync(join(d, 'opal.legacy.db')).equals(before)).toBe(true);
		expect(existsSync(`${p}.new`)).toBe(false);
		expect(existsSync(join(d, 'import-report.txt'))).toBe(true);
		expect(JSON.parse(readFileSync(join(d, 'import-report.json'), 'utf8')).tables.user.imported).toBe(2);
		expect(existsSync(join(d, 'blobs'))).toBe(true);
		expect(await importInPlace(p, { open })).toBeNull();
	});

	test('the renamed file is complete on its own: no WAL left behind, every row readable', async () => {
		const d = tmp();
		const p = buildLegacyFixture(d);
		await importInPlace(p, { open });
		expect(existsSync(`${p}.new-wal`)).toBe(false);
		const db = new Database(p, { readonly: true });
		expect((db.query('SELECT COUNT(*) AS n FROM part').get() as { n: number }).n).toBe(6);
		db.close();
	});

	test('refuses when opal.legacy.db exists', async () => {
		const d = tmp();
		const p = buildLegacyFixture(d);
		copyFileSync(p, join(d, 'opal.legacy.db'));
		const before = readFileSync(p);
		await expect(importInPlace(p, { open })).rejects.toThrow('already exists');
		expect(readFileSync(p).equals(before)).toBe(true);
	});
});

describe('seeded demo database', () => {
	test.skipIf(!existsSync(SEED))('imports with zero failed rows and no stock differences', async () => {
		const d = tmp();
		const copy = join(d, 'seed.db');
		copyFileSync(SEED, copy);
		const report = await importLegacy(copy, join(d, 'out.db'), { open });
		expect(report.failedRows).toEqual([]);
		for (const [name, t] of Object.entries(report.tables)) {
			if (name === 'designator_sequence') continue;
			expect([name, t.imported]).toEqual([name, t.read]);
		}
		expect(report.stockDifferences).toEqual([]);
		const out = new Database(join(d, 'out.db'), { readonly: true });
		expect(out.query('PRAGMA foreign_key_check').all()).toEqual([]);
		out.close();
	});

	test('buildDemoContent fills an empty database from the embedded seed', async () => {
		const db = await openSchemaDb(':memory:');
		buildDemoContent(db);
		const raw = db.$client as unknown as Database;
		const n = (t: string) => (raw.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
		expect([n('part'), n('execution'), n('step_execution'), n('procedure'), n('project')]).toEqual([182, 4, 342, 6, 1]);
		expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});

void LEGACY_HEAD;
