/**
 * A legacy (Python-era) database with rows in every table, for the import tests.
 * `buildLegacyFixture(dir)` writes `<dir>/opal.db` and the attachment files in
 * `<dir>/attachments`, and returns the database path.
 *
 * The data is small and chosen so that each mapping rule has a row that exercises it. A
 * comment above each group says which rule.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEGACY_HEAD = 'b8d2f1a5c3e0';
const SCHEMA = join(import.meta.dir, 'legacy-schema.sql');
const T0 = '2026-03-01 10:00:00.123456';
const T1 = '2026-03-02 11:30:00.5';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
export const PDF = new TextEncoder().encode('%PDF-1.4 fixture');

type Row = Record<string, unknown>;

function ins(db: Database, table: string, row: Row): void {
	const full: Row = { created_at: T0, updated_at: T1, ...row };
	const cols = Object.keys(full).filter((k) => !(k === 'updated_at' && !hasCol(db, table, 'updated_at')) && !(k === 'created_at' && !hasCol(db, table, 'created_at')));
	db.run(
		`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
		cols.map((c) => (typeof full[c] === 'object' && full[c] !== null && !(full[c] instanceof Uint8Array) ? JSON.stringify(full[c]) : (full[c] as never)))
	);
}
const known = new Map<string, Set<string>>();
function hasCol(db: Database, table: string, col: string): boolean {
	let set = known.get(table);
	if (!set) {
		set = new Set((db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((r) => r.name));
		known.set(table, set);
	}
	return set.has(col);
}

export function buildLegacyFixture(dir: string, opts: { version?: string } = {}): string {
	mkdirSync(join(dir, 'attachments', 'avatars'), { recursive: true });
	const path = join(dir, 'opal.db');
	const db = new Database(path, { create: true });
	db.exec(readFileSync(SCHEMA, 'utf8'));
	db.run('DELETE FROM alembic_version');
	db.run('INSERT INTO alembic_version VALUES (?)', [opts.version ?? LEGACY_HEAD]);
	known.clear();

	// ---- files
	writeFileSync(join(dir, 'attachments', 'a1.png'), PNG);
	writeFileSync(join(dir, 'attachments', 'a7.png'), PNG); // same bytes as a1: one blob
	writeFileSync(join(dir, 'attachments', 'a2.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
	writeFileSync(join(dir, 'attachments', 'a3.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 8, 8, 8]));
	writeFileSync(join(dir, 'attachments', 'a5.pdf'), PDF);
	writeFileSync(join(dir, 'attachments', 'a6.pdf'), new TextEncoder().encode('%PDF orphan'));
	writeFileSync(join(dir, 'attachments', 'avatars', 'ada.png'), PNG);

	// ---- org: workcenters, users, tokens, passkeys, roles, settings
	ins(db, 'workcenter', { id: 1, name: 'Bench', code: 'BENCH', description: 'Main bench', location: 'Shop', is_active: 1 });
	ins(db, 'workcenter', { id: 2, name: 'Test stand', code: 'STAND', is_active: 0 });
	ins(db, 'user', {
		id: 7, name: 'Ada', username: 'ada', password_hash: 'argon2$hash', email: 'ada@x.test', oidc_issuer: 'https://id.test',
		oidc_subject: 'sub-1', is_active: 1, is_admin: 1, needs_profile_setup: 0, needs_onboarding: 1, job_title: 'Lead',
		phone: '555-0100', workcenter_id: 1, avatar_filename: 'ada.png', avatar_mime: 'image/png', avatar_source: 'upload',
		avatar_updated_at: T1, last_seen_at: T1, current_activity: 'x'
	});
	ins(db, 'user', {
		id: 8, name: 'Bob', username: 'bob', email: 'bob@x.test', is_active: 1, is_admin: 0, needs_profile_setup: 1, needs_onboarding: 0,
		workcenter_id: 99, avatar_filename: 'missing.png', avatar_source: 'upload'
	});
	ins(db, 'api_token', { id: 3, user_id: 7, name: 'cli', token_hash: 'abc123', last_used_at: '2026-10-25 01:02:03' });
	ins(db, 'auth_session', { id: 1, user_id: 7, token_hash: 'sess', auth_method: 'password', expires_at: T1 });
	ins(db, 'webauthn_challenge', { id: 1, nonce: 'n', kind: 'login', rp_id: 'x', state_json: '{}', expires_at: T1 });
	ins(db, 'passkey_credential', { id: 4, user_id: 7, credential_id: new Uint8Array([1, 2, 3]), public_key: new Uint8Array([4, 5, 6, 7]), sign_count: 9, name: 'Key', aaguid: 'aa', transports: 'usb' });
	ins(db, 'role', { id: 1, name: 'Engineer', description: 'Dispositions', key: 'engineer', is_system: 1 });
	ins(db, 'role', { id: 2, name: 'Welder', is_system: 0 });
	ins(db, 'role', { id: 3, name: 'Gone', is_system: 0, deleted_at: T1 });
	ins(db, 'user_role', { id: 1, user_id: 7, role_id: 1, granted_by_id: 7, granted_at: T1 });
	ins(db, 'user_role', { id: 2, user_id: 8, role_id: 3, granted_by_id: null, granted_at: T1 });
	ins(db, 'role_gate', { id: 1, role_id: 1, gate: 'issue.disposition' });
	ins(db, 'role_gate', { id: 2, role_id: 3, gate: 'issue.approve' });
	ins(db, 'app_setting', { key: 'project_config', value: JSON.stringify({ name: 'Kestrel Test', description: 'Rocket', tiers: [{ level: 1, name: 'FLIGHT', code: 'F', description: '' }, { level: 2, name: 'GROUND', code: 'G', description: '' }], part_numbering: { prefix: 'KT', separator: '-', sequence_digits: 4, format: '{prefix}{sep}{tier_code}{sep}{sequence}' } }) });
	ins(db, 'app_setting', { key: 'passkeys_enabled', value: 'false' });
	ins(db, 'app_setting', { key: 'oidc_issuer', value: 'https://id.test' });
	ins(db, 'app_setting', { key: 'some_other_key', value: '1' });

	// ---- parts, structure (part.parent_id and bom_lines), suppliers
	const part = (id: number, pn: string | null, name: string, o: Row = {}) =>
		ins(db, 'part', { id, internal_pn: pn, name, unit_of_measure: 'ea', tracking_type: 'bulk', procurement: 'buy', tier: 2, is_tooling: 0, lifecycle_state: 'active', ...o });
	part(10, 'KT-G-0001', 'Washer', { reorder_point: 1.2345, metadata: { color: 'red' }, activation_cause: 'first article', activated_at: '2026-01-02 03:04:05.678912', activated_by_id: 7, category: 'Hardware' });
	part(11, 'KT-G-0002', 'Gone', { deleted_at: '2026-05-05 00:00:00', parent_id: 13 });
	part(12, null, 'No number', { lifecycle_state: 'draft', reorder_point: 0.0001, activated_by_id: 55 });
	part(13, 'KT-F-0001', 'Valve assembly', { tier: 1, tracking_type: 'serialized', procurement: 'make' });
	part(14, 'KT-G-0003', 'Bolt', { parent_id: 13 });
	part(15, 'KT-G-0004', 'Torque wrench', { is_tooling: 1, calibration_interval_days: 365, procurement: 'buy' });
	ins(db, 'bom_lines', { id: 5, assembly_id: 13, component_id: 10, quantity: 4, reference_designator: 'R1', notes: 'four' });
	ins(db, 'bom_lines', { id: 6, assembly_id: 13, component_id: 14, quantity: 3 }); // wins over parent_id (quantity 3, not 1)
	ins(db, 'supplier', { id: 1, name: 'Acme', code: 'ACM', is_active: 1, deleted_at: T1 });
	ins(db, 'supplier', { id: 2, name: 'Bolt Co', is_active: 1, website: 'https://bolt.test' });
	ins(db, 'supplier_part', { id: 1, supplier_id: 2, part_id: 14, vendor_pn: 'B-14', is_preferred: 1 });
	ins(db, 'supplier_part', { id: 2, supplier_id: 2, part_id: 99, vendor_pn: 'orphan', is_preferred: 0 });

	// ---- purchasing
	ins(db, 'purchase', { id: 1, reference: 'PO-0001', supplier: 'Bolt Co', supplier_id: 2, status: 'partial', ordered_at: T1, target_date: '2026-04-01', created_by_id: 7 });
	ins(db, 'purchase', { id: 2, reference: null, supplier: 'Walk-in shop', supplier_id: null, status: 'draft', notes: 'cash' });
	ins(db, 'purchase_line', { id: 1, purchase_id: 1, part_id: 10, qty_ordered: 10, qty_received: 10, unit_cost: 1.5 });
	ins(db, 'purchase_line', { id: 2, purchase_id: 1, part_id: 14, qty_ordered: 0, qty_received: 0 }); // qty 0: failed row
	ins(db, 'purchase_expense', { id: 1, purchase_id: 1, purchase_line_id: 1, part_id: 10, quantity: 10, unit_cost: 1.5, total_cost: 15, tier: 2, received_at: T1 });
	ins(db, 'purchase_expense', { id: 2, purchase_id: 1, quantity: 1, total_cost: 12.5, received_at: T1, notes: 'shipping: freight' });

	// Receipts the old database counted on the line with no stock record behind them.
	ins(db, 'purchase', { id: 3, reference: 'PO-0003', supplier: 'Bolt Co', supplier_id: 2, status: 'ordered', ordered_at: T1 }); // line 3 has 8 of 20: becomes partial
	ins(db, 'purchase', { id: 4, reference: 'PO-0004', supplier: 'Bolt Co', supplier_id: 2, status: 'partial', ordered_at: T1, received_at: '2026-03-05 08:00:00' }); // line 5 is complete: becomes received
	ins(db, 'purchase_line', { id: 3, purchase_id: 3, part_id: 12, qty_ordered: 20, qty_received: 8 });
	ins(db, 'purchase_line', { id: 4, purchase_id: 3, part_id: 14, qty_ordered: 5, qty_received: 0 });
	ins(db, 'purchase_line', { id: 5, purchase_id: 4, part_id: 12, qty_ordered: 5, qty_received: 5 });

	// ---- procedures
	ins(db, 'master_procedure', { id: 1, template_number: 'T-0001', name: 'Valve build', description: 'd', procedure_type: 'build', status: 'active', current_version_id: 1 });
	ins(db, 'master_procedure', { id: 2, template_number: 'T-0002', name: 'Old', procedure_type: 'op', status: 'draft', deleted_at: T1 });
	const step = (id: number, o: Row) =>
		ins(db, 'procedure_step', { id, procedure_id: 1, level: 0, is_contingency: 0, requires_signoff: 0, strict_sequence: 0, ...o });
	step(100, { parent_step_id: null, order: 1, step_number: '1', title: 'Prepare', requires_signoff: 1, required_role: 'Engineer', instructions: 'See ![d](/api/attachments/3/download)', callouts: [{ kind: 'caution', text: 'Hot' }], workcenter_id: 1 });
	step(101, { parent_step_id: 100, order: 2, step_number: '1.1', level: 1, title: 'Clean', required_data_schema: { fields: [{ name: 'torque', type: 'number', required: true }] }, signoffs: [{ label: 'Primary buyoff', role: 'Engineer' }, { label: 'Secondary buyoff', role: null }] });
	step(102, { parent_step_id: 100, order: 3, step_number: '1.2', level: 1, title: 'Fit', estimated_duration_minutes: 15 });
	step(103, { parent_step_id: null, order: 4, step_number: 'C1', title: 'Rework', is_contingency: 1, strict_sequence: 1 });
	ins(db, 'step_dependency', { id: 1, step_id: 103, depends_on_step_id: 100 });
	ins(db, 'step_dependency', { id: 2, step_id: 103, depends_on_step_id: 999 });
	ins(db, 'kit', { id: 1, procedure_id: 1, part_id: 10, quantity_required: 4 });
	ins(db, 'kit', { id: 2, procedure_id: 1, part_id: 10, quantity_required: 1 }); // repeats the part: failed row
	ins(db, 'step_kit', { id: 1, step_id: 102, part_id: 14, quantity_required: 2, usage_type: 'consume', notes: 'loctite' });
	ins(db, 'step_kit', { id: 2, step_id: 102, part_id: 15, quantity_required: 1, usage_type: 'tooling' });
	ins(db, 'procedure_output', { id: 1, procedure_id: 1, part_id: 13, quantity_produced: 1 });
	ins(db, 'step_image', { id: 1, step_id: 101, attachment_id: 2, caption: 'Clean here', position: 0 });
	ins(db, 'step_image', { id: 2, step_id: 102, attachment_id: 2, caption: 'dup', position: 0 }); // same attachment twice: failed row
	const content = {
		procedure_name: 'Valve build',
		procedure_description: 'd',
		change_note: 'first',
		steps: [
			{ id: 100, order: 1, step_number: '1', level: 0, parent_step_id: null, title: 'Prepare', instructions: 'See ![d](/api/attachments/3/download)', requires_signoff: true, required_role: 'Engineer', callouts: [{ kind: 'caution', text: 'Hot' }], workcenter_id: 1, depends_on: [] },
			{ id: 101, order: 2, step_number: '1.1', level: 1, parent_step_id: 100, title: 'Clean', required_data_schema: { fields: [{ name: 'torque', type: 'number' }] }, signoffs: [{ label: 'Primary buyoff', role: 'Engineer' }, { label: 'Secondary buyoff', role: null }], images: [{ attachment_id: 2, caption: 'Clean here' }, { attachment_id: 404 }] },
			{ id: 102, order: 3, step_number: '1.2', level: 1, parent_step_id: 100, title: 'Fit', step_kit: [{ part_id: 14, part_name: 'Bolt', quantity_required: 2, usage_type: 'consume' }, { part_id: 15, quantity_required: 1, usage_type: 'tooling' }] },
			{ id: 103, order: 4, step_number: 'C1', level: 0, parent_step_id: null, title: 'Rework', is_contingency: true, strict_sequence: true, caution: 'Careful', depends_on: [1] }
		],
		kit_items: [{ part_id: 10, quantity_required: 4 }],
		output_items: [{ part_id: 13, quantity_produced: 1 }]
	};
	ins(db, 'procedure_version', { id: 1, procedure_id: 1, version_number: 1, content, created_by_id: 7 });

	// ---- attachments
	const att = (id: number, file: string, o: Row = {}) =>
		ins(db, 'attachment', { id, original_filename: `${file}`, stored_filename: file, mime_type: file.endsWith('pdf') ? 'application/pdf' : 'image/png', size_bytes: 1, uploaded_by_id: 7, ...o });
	att(1, 'a1.png', { issue_id: 1, kind: 'reference', note: 'photo' });
	att(2, 'a2.png', { procedure_id: 1, kind: 'step_image' });
	att(3, 'a3.png', { procedure_id: 1, kind: 'inline' });
	att(4, 'a4-missing.png', { issue_id: 1 });
	att(5, 'a5.pdf', { purchase_id: 1, kind: 'quote' });
	att(6, 'a6.pdf', {});
	att(7, 'a7.png', { step_execution_id: 1, kind: 'capture' });

	// ---- inventory
	const rec = (id: number, partId: number, quantity: number, o: Row = {}) =>
		ins(db, 'inventory_record', { id, part_id: partId, quantity, location: 'SHELF', opal_number: `OPAL-${String(id).padStart(5, '0')}`, source_type: 'manual', ...o });
	rec(1, 10, 10, { source_type: 'purchase', source_purchase_line_id: 1, lot_number: 'L1', expiration_date: '2027-01-31' }); // consumed 3 below; diff becomes a receive linked to line 1
	rec(2, 10, 5, { alias: 'box' }); // found +2, damaged -1, diff receive 4
	rec(3, 10, 1, { last_counted_at: '2026-04-04 04:04:04' }); // count move from a cycle_count consumption
	rec(4, 15, 1, { last_calibrated_at: '2026-01-01 00:00:00', calibration_due_at: '2027-01-01 00:00:00' }); // tooling use
	rec(5, 13, 1, { source_type: 'production', source_production_id: 1, lot_number: 'WO-00001', location: 'CRATE' }); // produced by work order 1
	rec(6, 13, 0, { source_type: 'production', source_production_id: 2, lot_number: 'WO-00002' }); // planned output
	rec(7, 14, 4); // transfer source: moved 6 out
	rec(8, 14, 6, { source_type: 'transfer', location: 'BIN' }); // transfer target
	rec(9, 14, 3, { opal_number: null, lot_number: 'S-9' }); // no OPAL number; bulk lot stays a lot
	rec(10, 10, 2, { source_type: 'production' }); // nothing explains the 2: import adjustment, listed
	rec(11, 13, 1, { lot_number: 'SN-77' }); // serialized part: the lot is the serial
	const cons = (id: number, record: number, q: number, o: Row = {}) =>
		ins(db, 'inventory_consumption', { id, inventory_record_id: record, quantity: q, consumption_type: 'procedure', usage_type: 'consume', ...o });
	cons(1, 1, 3, { procedure_instance_id: 1, step_execution_id: 2, consumed_by_id: 7 });
	cons(2, 2, 1, { consumption_type: 'scrap', notes: '[damage] dropped on floor' });
	cons(3, 3, 1, { consumption_type: 'adjustment', notes: '[cycle_count]' });
	cons(4, 4, 5, { usage_type: 'tooling', procedure_instance_id: 1 });
	ins(db, 'inventory_production', { id: 1, inventory_record_id: 5, quantity: 1, procedure_instance_id: 1, serial_number: '001', produced_opal_number: 'OPAL-00005', status: 'completed', produced_by_id: 7 });
	ins(db, 'inventory_production', { id: 2, inventory_record_id: 6, quantity: 1, procedure_instance_id: 2, serial_number: '002', status: 'wip' });
	ins(db, 'inventory_production', { id: 3, inventory_record_id: 2, quantity: 2, status: 'completed', notes: '[found] behind shelf' });
	ins(db, 'assembly_component', { id: 1, production_id: 1, consumption_id: 1, component_opal_number: 'OPAL-00001', quantity_used: 3 });
	ins(db, 'stock_transfer', { id: 1, source_inventory_id: 7, target_inventory_id: 8, part_id: 14, quantity: 6, source_location: 'SHELF', target_location: 'BIN', source_lot_number: null, target_lot_number: 'T1', status: 'completed', transferred_by_id: 7, transferred_at: '2026-04-05 05:05:05' });
	ins(db, 'stock_transfer', { id: 2, source_inventory_id: 8, target_inventory_id: null, part_id: 14, quantity: 1, source_location: 'BIN', target_location: 'X', status: 'pending' });
	ins(db, 'test_template', { id: 1, part_id: 10, name: 'Hardness', required: 1, test_type: 'numeric', min_value: 8.2, max_value: 9.9, unit: 'HRC', sort_order: 1 });
	ins(db, 'stock_test_result', { id: 1, inventory_record_id: 1, template_id: 1, test_name: 'Hardness', result: 'pass', value: '9', tested_at: T1, tested_by_id: 7 });

	// ---- issues, risks, requirements, datasets, notifications
	const issue = (id: number, o: Row = {}) =>
		ins(db, 'issue', { id, issue_number: `IT-${String(id).padStart(5, '0')}`, title: `Issue ${id}`, issue_type: 'non_conformance', status: 'open', priority: 'high', containment: 'step', ...o });
	issue(1, { part_id: 10, procedure_id: 1, procedure_instance_id: 1, raised_step_id: 2, containment_step_id: 2, raised_by_id: 7, assigned_to_id: 8 });
	issue(2, { status: 'closed', closed_at: T1, closed_by_id: 7, disposition_type: 'rework', dispositioned_at: T1, dispositioned_by_id: 7, root_cause: 'rc', corrective_action: 'ca', containment: 'advisory', issue_type: 'task' });
	issue(3, { deleted_at: T1, procedure_id: 1 });
	ins(db, 'issue_comment', { id: 1, issue_id: 1, user_id: 7, body: 'Looking' });
	ins(db, 'issue_reference', { id: 1, issue_id: 1, reference_type: 'opal', reference_value: 'OPAL-00001' });
	ins(db, 'risk', { id: 1, risk_number: 'RISK-00001', title: 'Leak', condition: 'c', departure: 'd', asset_part_id: 10, consequence: 'x', disposition: 'mitigate', owner_id: 7, probability: 4, impact: 5, realized_issue_id: 1 });
	ins(db, 'risk', { id: 2, risk_number: 'RISK-00002', title: 'Gone', asset_text: 'the pad', disposition: 'watch', probability: 9, impact: 2, deleted_at: T1 });
	ins(db, 'risk_reference', { id: 1, risk_id: 1, reference_type: 'work_order', reference_value: 'WO-00001' });
	ins(db, 'risk_issue_link', { id: 1, risk_id: 1, issue_id: 2, role: 'mitigation' });
	const req = (id: number, n: number, o: Row = {}) =>
		ins(db, 'requirement', { id, req_number: `REQ-${String(n).padStart(4, '0')}`, title: `R${n}`, statement: 'The system shall x', level: 0, tbd: 0, tbr: 0, stale: 0, lifecycle_state: 'draft', revision: 1, ...o });
	req(1, 1, { lifecycle_state: 'baselined', baselined_at: T1, baselined_by_id: 7, verification_method: 'test' });
	req(2, 2, { parent_id: 1, level: 1, tbr: 1, tbr_owner_id: 7, tbr_due: '2026-12-01 00:00:00' });
	req(3, 3, { deleted_at: T1 });
	req(4, 1, { revision: 2, supersedes_id: 1, lifecycle_state: 'preliminary' });
	ins(db, 'baseline_event', { id: 1, label: 'v1', note: 'n', signed_by_id: 7 });
	ins(db, 'baseline_event_item', { id: 1, event_id: 1, requirement_id: 1 });
	ins(db, 'part_requirements', { id: 1, part_id: 10, requirement_id: 'REQ-0001', requirement_ref_id: 1, status: 'verified', verified_at: T1, verified_by_id: 7 });
	ins(db, 'part_requirements', { id: 2, part_id: 14, requirement_id: 'REQ-0002', requirement_ref_id: null, status: 'open' }); // resolved by number
	ins(db, 'part_requirements', { id: 3, part_id: 14, requirement_id: 'LEGACY-TEXT', requirement_ref_id: null, status: 'open' }); // kept in legacy_row
	ins(db, 'dataset', { id: 1, name: 'Chamber pressure', schema: { fields: [{ name: 'psi', type: 'number' }] }, procedure_id: 1 });
	ins(db, 'dataset', { id: 2, name: 'Old', schema: { fields: [] }, deleted_at: T1 });
	ins(db, 'data_point', { id: 1, dataset_id: 1, recorded_at: '2026-04-04 04:04:04.5', values: { psi: 100 }, step_execution_id: 2 });
	ins(db, 'notification', { id: 1, user_id: 7, actor_id: 8, kind: 'issue_assigned', priority: 'normal', title: 'Assigned', href: '/issues/1', subject_type: 'issue', subject_id: 1, read_at: T1 });
	ins(db, 'notification', { id: 2, user_id: 7, kind: 'mystery', priority: 'normal', title: 'x', href: '/', subject_type: 'issue', subject_id: 1 });

	// ---- executions: work order 1 ran the whole procedure, 2 is planned output only
	ins(db, 'procedure_instance', { id: 1, procedure_id: 1, version_id: 1, work_order_number: 'WO-00001', status: 'in_work', started_at: T1, started_by_id: 7, participants: [{ user_id: 7, user_name: 'Ada', joined_at: '2026-03-02T11:00:00+00:00', last_step: null }], priority: 2, scheduled_start_at: T1 });
	ins(db, 'procedure_instance', { id: 2, procedure_id: 1, version_id: 1, work_order_number: null, status: 'cut', priority: 0 });
	const se = (id: number, order: number, status: string, o: Row = {}) =>
		ins(db, 'step_execution', { id, instance_id: 1, step_number: order, status, step_number_str: String(order), level: 0, requires_signoff: 0, ...o });
	se(1, 1, 'awaiting_signoff', { step_number_str: '1' }); // OP with sub-steps, children done
	se(2, 2, 'completed', { level: 1, parent_step_order: 1, step_number_str: '1.1', completed_at: T1, completed_by_id: 7, data_captured: { torque: 12 }, started_at: T0, workcenter_id: 1 });
	se(3, 3, 'signed_off', { level: 1, parent_step_order: 1, step_number_str: '1.2', completed_at: T0, completed_by_id: 8, signed_off_at: T1, signed_off_by_id: 7 });
	se(4, 4, 'skipped', { step_number_str: 'C1' });
	se(5, 5, 'pending', { ad_hoc_issue_id: 1, ad_hoc_host_order: 1, level: 0, step_number_str: '1R1', title: 'Redo prep', requires_signoff: 0 });
	se(6, 6, 'in_progress', { ad_hoc_issue_id: 1, ad_hoc_host_order: 1, level: 1, parent_step_order: 5, step_number_str: '1R1.1', title: 'Wipe', instructions: 'wipe it', requires_signoff: 1, started_at: T1 });
	ins(db, 'step_signoff', { id: 1, step_execution_id: 2, slot: 0, label: 'Primary buyoff', role: 'Engineer', signed_by_id: 7, signed_at: T1 });
	ins(db, 'step_note', { id: 1, step_execution_id: 2, author_id: 7, body: 'Looks fine' });
	ins(db, 'step_focus', { id: 1, instance_id: 1, step_execution_id: 6, user_id: 8, focused_at: T1 });

	// ---- the rest
	ins(db, 'audit_log', { id: 1, timestamp: T0, table_name: 'part', record_id: 10, action: 'create', user_id: 7, old_values: null, new_values: { name: 'Washer' } });
	ins(db, 'audit_log', { id: 2, timestamp: T1, table_name: 'part', record_id: 10, action: 'update', user_id: null, old_values: { name: 'Washer' }, new_values: { name: 'Washer 2' } });
	const seq = (t: string, v: number) => ins(db, 'designator_sequence', { designator_type: t, last_value: v });
	seq('OPAL', 3); // below the highest number in use (11): the importer raises it
	seq('WO', 9); // above: kept
	seq('SN-KT-F-0001', 2);
	ins(db, 'extension', { id: 'ext1', name: 'E', version: '1', origin: 'user', enabled: 1, installed_at: T0, manifest: {} });
	ins(db, 'onshape_link', { part_id: 10, document_id: 'd', element_id: 'e', part_id_onshape: 'p', stale: 0 });
	ins(db, 'onshape_sync_log', { started_at: T0, direction: 'pull', trigger: 'manual', status: 'ok', parts_created: 0, parts_updated: 0, bom_lines_created: 0, bom_lines_updated: 0, bom_lines_removed: 0 });
	db.close();
	return path;
}
