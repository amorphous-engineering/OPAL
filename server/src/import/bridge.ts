/**
 * Brings a private copy of a released 1.x database forward to LEGACY_HEAD, the one schema the
 * importer reads. It runs in place of Python and Alembic, which nobody has to install.
 *
 * Each step is the data part of one Alembic migration, in Alembic's order, ported from the file
 * of the same revision (git: `migrations/versions` at the last Python commit, b94901e0). The
 * steps change columns and rows only. Indexes and constraints do not matter on a copy that is
 * only read, and 1.x databases do not agree on them anyway: a database made by `opal init` has
 * no constraint names, which is why the real e7a1c93f2b48 fails on a fresh 1.3.2 database. For
 * the same reason a step never assumes a column is absent. A fresh database comes from the
 * models and a migrated one from the migrations, and the two differ at the same revision.
 *
 * Three things are left out on purpose, and the import lists them as not imported where they
 * exist: the search index (FTS triggers are dropped first, the server has its own index), and
 * the extension, webauthn_challenge and auth_session tables.
 *
 * Tested against real Alembic: test/fixtures/legacy-released holds databases made by the released
 * code at each tag, next to the same databases upgraded by Alembic.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { ident } from './context.ts';

export const LEGACY_HEAD = 'b8d2f1a5c3e0';

/** Alembic heads of the 1.x releases, oldest first. */
export const RELEASED_HEADS: Readonly<Record<string, string>> = {
	'00d3ac121e5e': '1.2.2 to 1.2.8',
	a310ab9da1d8: '1.3.0-beta',
	'0c42f39a04cc': '1.3.0 to 1.3.1',
	'8a5444d1e3e6': '1.3.2',
	d4e8b7a2c5f1: '1.4.0-beta.1',
	c1a2b3d4e5f6: '1.4.0-beta.2',
	f3a9d2c8b501: '1.4.0-beta.3'
};

export interface BridgeStep {
	revision: string;
	title: string;
	/** What changed in the rows. Empty when the step only added columns or tables. */
	changes: string[];
	/** The stamp said this step had run, and the file said it had not. */
	pastStamp?: boolean;
}

export interface RetiredColumn {
	table: string;
	column: string;
	/** Rows that held a value when the column was retired. */
	rows: number;
	why: string;
}

export interface BridgeReport {
	from: string;
	/** The 1.x releases that left a database at `from`. */
	release: string;
	to: string;
	steps: BridgeStep[];
	/** Tables the source did not have. Their rows, if any, came from the steps. */
	createdTables: string[];
	retiredColumns: RetiredColumn[];
}

/** What a step can do to the copy. */
class Bridge {
	readonly retired: RetiredColumn[] = [];
	changes: string[] = [];
	readonly at = new Date().toISOString().replace('T', ' ').replace('Z', '000');

	constructor(readonly db: Database) {}

	columns(table: string): Set<string> {
		return new Set((this.db.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((r) => r.name));
	}

	addColumn(table: string, column: string, type = '', dflt?: string): void {
		if (this.columns(table).has(column)) return;
		this.db.query(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${type}${dflt === undefined ? '' : ` NOT NULL DEFAULT ${dflt}`}`).run();
	}

	renameColumn(table: string, from: string, to: string): void {
		if (this.columns(table).has(from)) this.db.query(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`).run();
	}

	/** Records the value count now. The column goes at the end of the bridge, when no step can need it. */
	retire(table: string, column: string, why: string): void {
		if (!this.columns(table).has(column)) return;
		const n = this.db.query(`SELECT COUNT(*) AS n FROM ${ident(table)} WHERE ${ident(column)} IS NOT NULL`).get() as { n: number };
		this.retired.push({ table, column, rows: n.n, why });
	}

	/** Runs one statement and returns the rows it changed. A prepared statement can never be two. */
	run(sql: string, ...params: SQLQueryBindings[]): number {
		return this.db.query(sql).run(...params).changes;
	}

	all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
		return this.db.query(sql).all(...params) as T[];
	}

	/** Runs a statement and, when it changed rows, says so in the report. */
	note(what: string, sql: string, ...params: SQLQueryBindings[]): void {
		this.count(what, this.run(sql, ...params));
	}

	count(what: string, n: number): void {
		if (n > 0) this.changes.push(`${what}: ${n}`);
	}

	/** SQLite refuses DROP COLUMN on an indexed or constrained column, so the table is rebuilt. */
	dropRetiredColumns(): void {
		for (const table of new Set(this.retired.map((r) => r.table))) {
			const gone = new Set(this.retired.filter((r) => r.table === table).map((r) => r.column));
			const keep = [...this.columns(table)].filter((c) => !gone.has(c)).map(ident);
			const copy = ident(`__bridge_${table}`);
			this.run(`CREATE TABLE ${copy} AS SELECT ${keep.join(', ')} FROM ${ident(table)}`);
			this.run(`DROP TABLE ${ident(table)}`);
			this.run(`ALTER TABLE ${copy} RENAME TO ${ident(table)}`);
		}
	}
}

const AT = 'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL';
const ID = 'id INTEGER PRIMARY KEY';

type Row = Record<string, unknown>;

function parseJson(v: unknown): unknown {
	if (typeof v !== 'string') return v ?? null;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- f1e2d3c4b5a6

function usernameify(raw: string): string {
	const slug = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '');
	return slug.slice(0, 64) || 'user';
}

function credentialedAuth(b: Bridge): void {
	// Databases that came through the migrations never got this column: 00d3ac121e5e was empty.
	b.addColumn('user', 'needs_onboarding', 'BOOLEAN', '0');
	const hadUsernames = b.columns('user').has('username');
	b.addColumn('user', 'username', 'VARCHAR(64)');
	b.addColumn('user', 'password_hash', 'VARCHAR(255)');
	if (!hadUsernames) {
		const taken = new Set<string>();
		const users = b.all<{ id: number; name: string | null; email: string | null }>('SELECT id, name, email FROM "user" ORDER BY id');
		for (const u of users) {
			const base = usernameify((u.email ?? '').split('@')[0] || u.name || `user${u.id}`);
			let candidate = base;
			for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}${suffix}`;
			taken.add(candidate);
			b.run('UPDATE "user" SET username = ? WHERE id = ?', candidate, u.id);
		}
		b.count('user: username made from the email or name, no password', users.length);
	}
	b.run(`CREATE TABLE IF NOT EXISTS api_token (${ID}, user_id INTEGER NOT NULL, name VARCHAR(100) NOT NULL, token_hash VARCHAR(64) NOT NULL, last_used_at DATETIME, revoked_at DATETIME, ${AT})`);
	b.run(`CREATE TABLE IF NOT EXISTS passkey_credential (${ID}, user_id INTEGER NOT NULL, credential_id BLOB NOT NULL, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, name VARCHAR(100) NOT NULL, aaguid VARCHAR(36), transports VARCHAR(100), last_used_at DATETIME, ${AT})`);
}

// ---------------------------------------------------------------- ccf93c36170a

function partLifecycle(b: Bridge): void {
	b.addColumn('part', 'lifecycle_state', 'VARCHAR(20)', "'draft'");
	b.addColumn('part', 'activated_at', 'DATETIME');
	b.addColumn('part', 'activated_by_id', 'INTEGER');
	b.addColumn('part', 'activation_cause', 'VARCHAR(255)');
	b.note(
		'part: set active, its number is already in use',
		"UPDATE part SET lifecycle_state = 'active', activated_at = CURRENT_TIMESTAMP, activation_cause = 'migration backfill (pre-lifecycle)'"
	);
	// Per-tier part number counters, from the highest number used, deleted parts included.
	const highest = new Map<number, number>();
	for (const p of b.all<{ tier: number; internal_pn: string }>('SELECT tier, internal_pn FROM part WHERE internal_pn IS NOT NULL')) {
		const m = /(\d+)\s*$/.exec(p.internal_pn);
		if (m) highest.set(p.tier, Math.max(highest.get(p.tier) ?? 0, Number(m[1])));
	}
	for (const [tier, last] of highest) {
		b.run(
			'INSERT INTO designator_sequence (designator_type, last_value, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (designator_type) DO UPDATE SET last_value = MAX(last_value, excluded.last_value)',
			`PN-${tier}`,
			last
		);
	}
	b.count('designator_sequence: part number counters added', highest.size);
}

// ---------------------------------------------------------------- a7c41d92e803

function issueContainment(b: Bridge): void {
	b.addColumn('issue', 'containment', 'VARCHAR(20)', "'advisory'");
	b.addColumn('issue', 'containment_step_id', 'INTEGER');
	b.addColumn('issue', 'raised_by_id', 'INTEGER');
	b.addColumn('issue', 'dispositioned_at', 'DATETIME');
	b.renameColumn('issue', 'step_execution_id', 'raised_step_id');
	b.renameColumn('issue', 'is_condition', 'actual');
	b.renameColumn('issue', 'disposition_notes', 'disposition_rationale');
	b.renameColumn('issue', 'disposition_approved_by_id', 'dispositioned_by_id');
	b.note('issue: disposition return_to_vendor is now return_to_supplier', "UPDATE issue SET disposition_type = 'return_to_supplier' WHERE disposition_type = 'return_to_vendor'");
	b.note(
		'issue: approved disposition signed at the last update',
		"UPDATE issue SET dispositioned_at = updated_at WHERE status = 'disposition_approved' AND disposition_type IS NOT NULL AND dispositioned_at IS NULL"
	);
	b.note('issue: execution non-conformance holds its step', "UPDATE issue SET containment = 'step' WHERE issue_type = 'non_conformance' AND raised_step_id IS NOT NULL");
	b.note('issue: status is now open', "UPDATE issue SET status = 'open' WHERE status IN ('investigating', 'disposition_pending', 'disposition_approved')");
	b.note('step_execution: on_hold is now in_progress, the issue holds the step', "UPDATE step_execution SET status = 'in_progress' WHERE status = 'on_hold'");
}

// ---------------------------------------------------------------- a7b9c1d3e5f7

const RISK_STATUS_TO_DISPOSITION: Record<string, string> = {
	identified: 'open',
	analyzing: 'research',
	mitigating: 'mitigate',
	monitoring: 'watch',
	closed: 'closed'
};

function riskScenarios(b: Bridge): void {
	b.run(`CREATE TABLE IF NOT EXISTS risk_issue_link (${ID}, risk_id INTEGER NOT NULL, issue_id INTEGER NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'mitigation', ${AT})`);
	for (const c of ['condition', 'departure', 'consequence', 'acceptance_rationale', 'watch_contingency']) b.addColumn('risk', c, 'TEXT');
	for (const c of ['asset_text', 'watch_observable', 'watch_threshold']) b.addColumn('risk', c, 'VARCHAR(255)');
	for (const c of ['asset_part_id', 'owner_id', 'residual_probability', 'residual_impact', 'accepted_by_id', 'last_reviewed_by_id', 'realized_issue_id']) b.addColumn('risk', c, 'INTEGER');
	for (const c of ['accepted_at', 'last_reviewed_at']) b.addColumn('risk', c, 'DATETIME');
	b.addColumn('risk', 'disposition', 'VARCHAR(20)', "'open'");

	let moved = 0;
	for (const [status, disposition] of Object.entries(RISK_STATUS_TO_DISPOSITION)) {
		moved += b.run('UPDATE risk SET disposition = ? WHERE status = ?', disposition, status);
	}
	b.count('risk: status moved to disposition', moved);
	b.note(
		'risk_issue_link: made from risk.linked_issue_id',
		"INSERT INTO risk_issue_link (risk_id, issue_id, role, created_at, updated_at) SELECT id, linked_issue_id, 'mitigation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM risk WHERE linked_issue_id IS NOT NULL"
	);
	b.note(
		'risk: mitigation plan moved into the description',
		"UPDATE risk SET description = CASE WHEN description IS NULL OR trim(description) = '' THEN 'LEGACY MITIGATION PLAN:' || char(10) || mitigation_plan ELSE description || char(10) || char(10) || 'LEGACY MITIGATION PLAN:' || char(10) || mitigation_plan END WHERE mitigation_plan IS NOT NULL AND trim(mitigation_plan) != ''"
	);
	b.retire('risk', 'status', 'moved to disposition');
	b.retire('risk', 'mitigation_plan', 'moved to the description, under LEGACY MITIGATION PLAN');
	b.retire('risk', 'linked_issue_id', 'moved to risk_issue_link');
}

// ---------------------------------------------------------------- b7e41c0d9a52

type Slot = { label: string; role: string | null };
type VersionStep = { order?: number; required_role?: string | null; requires_signoff?: unknown; signoffs?: { label?: string; role?: string }[] | null };

function effectiveSlots(step: VersionStep, hasChildren: boolean): Slot[] {
	const role = step.required_role ?? null;
	let requires = !!step.requires_signoff;
	const explicit = step.signoffs;
	if (explicit !== undefined && explicit !== null) {
		const slots = explicit.map((s) => ({ label: s.label || '', role: s.role || null }));
		if (slots.length || hasChildren) return slots;
		requires = false;
	}
	if (hasChildren) return requires ? [{ label: 'Sign-off', role }] : [];
	const slots: Slot[] = [{ label: 'Primary buyoff', role }];
	if (requires) slots.push({ label: 'Secondary buyoff', role: null });
	return slots;
}

function signoffSlots(b: Bridge): void {
	b.addColumn('procedure_step', 'signoffs', 'JSON');
	b.addColumn('step_execution', 'signoffs', 'JSON');
	b.addColumn('attachment', 'step_note_id', 'INTEGER');
	b.run(`CREATE TABLE IF NOT EXISTS step_signoff (${ID}, ${AT}, step_execution_id INTEGER NOT NULL, slot INTEGER NOT NULL, label VARCHAR(100) NOT NULL, role VARCHAR(50), signed_by_id INTEGER, signed_at DATETIME NOT NULL)`);

	const contents = new Map<number, Map<number, VersionStep>>();
	for (const v of b.all<{ id: number; content: unknown }>('SELECT id, content FROM procedure_version')) {
		const content = parseJson(v.content) as { steps?: VersionStep[] } | null;
		const steps = content && Array.isArray(content.steps) ? content.steps : [];
		contents.set(v.id, new Map(steps.filter((s) => s.order !== undefined).map((s) => [Number(s.order), s])));
	}
	const versionOf = new Map(b.all<{ id: number; version_id: number }>('SELECT id, version_id FROM procedure_instance').map((i) => [i.id, i.version_id]));
	const rows = b.all<Row>('SELECT id, instance_id, step_number, parent_step_order, status, completed_at, completed_by_id, signed_off_at, signed_off_by_id, ad_hoc_issue_id, requires_signoff, created_at, updated_at FROM step_execution');
	const key = (instance: unknown, order: unknown) => `${String(instance)}/${String(order)}`;
	const hasParent = new Set(rows.filter((r) => r.parent_step_order !== null).map((r) => key(r.instance_id, r.parent_step_order)));

	let written = 0;
	for (const r of rows) {
		if (r.status !== 'completed' && r.status !== 'awaiting_signoff' && r.status !== 'signed_off') continue;
		const hasChildren = hasParent.has(key(r.instance_id, r.step_number));
		if (hasChildren && r.status === 'awaiting_signoff') continue;
		let step: VersionStep;
		if (r.ad_hoc_issue_id !== null) step = { requires_signoff: Number(r.requires_signoff) !== 0 };
		else {
			step = { ...(contents.get(versionOf.get(Number(r.instance_id)) ?? -1)?.get(Number(r.step_number)) ?? {}) };
			if (Number(r.requires_signoff) !== 0) step.requires_signoff = true;
		}
		const slots = effectiveSlots(step, hasChildren);
		if (!slots.length) continue;

		const fallback = r.completed_at ?? r.updated_at ?? r.created_at ?? b.at;
		const first = hasChildren
			? { by: r.signed_off_by_id ?? r.completed_by_id, at: r.signed_off_at ?? fallback }
			: { by: r.completed_by_id, at: r.completed_at ?? fallback };
		const later = hasChildren ? first : { by: r.signed_off_by_id ?? r.completed_by_id, at: r.signed_off_at ?? fallback };

		const count = r.status === 'awaiting_signoff' ? 1 : slots.length;
		for (let n = 0; n < count; n++) {
			const who = n === 0 ? first : later;
			b.run(
				'INSERT INTO step_signoff (created_at, updated_at, step_execution_id, slot, label, role, signed_by_id, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				b.at,
				b.at,
				Number(r.id),
				n,
				slots[n]!.label || 'Sign-off',
				slots[n]!.role,
				who.by as number | null,
				who.at as string
			);
			written++;
		}
	}
	b.count('step_signoff: made from the status of finished steps', written);
}

// ---------------------------------------------------------------- d5a7c3e91f40

function slotRoles(signoffs: unknown): unknown[] {
	return Array.isArray(signoffs) ? signoffs.filter((s) => s && typeof s === 'object').map((s) => (s as { role?: unknown }).role) : [];
}

function rolesAndProfile(b: Bridge): void {
	b.run(`CREATE TABLE IF NOT EXISTS role (${ID}, ${AT}, deleted_at DATETIME, name VARCHAR(50) NOT NULL COLLATE NOCASE UNIQUE, description TEXT)`);
	b.run(`CREATE TABLE IF NOT EXISTS user_role (${ID}, user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, granted_by_id INTEGER, granted_at DATETIME NOT NULL)`);
	for (const [c, t] of [['job_title', 'VARCHAR(120)'], ['phone', 'VARCHAR(40)'], ['workcenter_id', 'INTEGER'], ['avatar_filename', 'VARCHAR(255)'], ['avatar_mime', 'VARCHAR(50)'], ['avatar_source', 'VARCHAR(10)'], ['avatar_updated_at', 'DATETIME']] as const) {
		b.addColumn('user', c, t);
	}

	const raw: unknown[] = [];
	for (const s of b.all<{ signoffs: unknown; required_role: unknown }>('SELECT signoffs, required_role FROM procedure_step')) {
		raw.push(s.required_role, ...slotRoles(parseJson(s.signoffs)));
	}
	for (const s of b.all<{ signoffs: unknown }>('SELECT signoffs FROM step_execution')) raw.push(...slotRoles(parseJson(s.signoffs)));
	for (const v of b.all<{ content: unknown }>('SELECT content FROM procedure_version')) {
		const content = parseJson(v.content) as { steps?: unknown } | null;
		for (const step of content && Array.isArray(content.steps) ? content.steps : []) {
			if (step && typeof step === 'object') raw.push((step as VersionStep).required_role, ...slotRoles((step as VersionStep).signoffs));
		}
	}
	// One role per distinct name, ignoring case. The first spelling seen wins.
	const names = new Map<string, string>();
	for (const value of raw) {
		if (typeof value !== 'string') continue;
		const name = value.trim().slice(0, 50);
		if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
	}
	if (!names.size) return;
	for (const name of names.values()) b.run('INSERT INTO role (name, created_at, updated_at) VALUES (?, ?, ?)', name, b.at, b.at);
	b.count('role: made from the role names on steps', names.size);
	const roleIds = b.all<{ id: number }>('SELECT id FROM role').map((r) => r.id);
	const userIds = b.all<{ id: number }>('SELECT id FROM "user" WHERE is_active = 1').map((u) => u.id);
	for (const u of userIds) {
		for (const r of roleIds) b.run('INSERT INTO user_role (user_id, role_id, granted_at) VALUES (?, ?, ?)', u, r, b.at);
	}
	b.count('user_role: those roles granted to every active person', userIds.length * roleIds.length);
}

// ---------------------------------------------------------------- e6b8d4f2a903

const SYSTEM_ROLES: readonly [key: string, name: string, description: string, gates: readonly string[], grantAll: boolean][] = [
	['engineer', 'Engineer', 'Dispositions issue tickets and verifies engineering-critical steps.', ['issue.disposition'], true],
	['technician', 'Technician', 'Performs build and assembly steps.', [], false],
	['quality', 'Quality', 'Approves issue resolutions and buys off quality-critical steps.', ['issue.approve'], true],
	['admin', 'Admin', 'Administers the application and passes every gate.', [], false]
];

function systemRoles(b: Bridge): void {
	b.addColumn('role', 'key', 'VARCHAR(30)');
	b.addColumn('role', 'is_system', 'BOOLEAN', '0');
	b.run(`CREATE TABLE IF NOT EXISTS role_gate (${ID}, role_id INTEGER NOT NULL, gate VARCHAR(50) NOT NULL)`);
	const active = b.all<{ id: number }>('SELECT id FROM "user" WHERE is_active = 1').map((u) => u.id);
	let granted = 0;
	for (const [key, name, description, gates, grantAll] of SYSTEM_ROLES) {
		const row = b.db.query('SELECT id, description FROM role WHERE name = ?').get(name) as { id: number; description: string | null } | null;
		let roleId: number;
		if (!row) {
			b.run('INSERT INTO role (name, description, key, is_system, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', name, description, key, b.at, b.at);
			roleId = (b.db.query('SELECT id FROM role WHERE key = ?').get(key) as { id: number }).id;
		} else {
			roleId = row.id;
			b.run('UPDATE role SET name = ?, key = ?, is_system = 1, deleted_at = NULL, description = ?, updated_at = ? WHERE id = ?', name, key, (row.description ?? '').trim() ? row.description : description, b.at, roleId);
		}
		for (const gate of gates) b.run('INSERT INTO role_gate (role_id, gate) VALUES (?, ?)', roleId, gate);
		if (key === 'admin') {
			// Membership is the is_admin flag; a stray grant would mean nothing.
			b.run('DELETE FROM user_role WHERE role_id = ?', roleId);
		} else if (grantAll) {
			const held = new Set(b.all<{ user_id: number }>('SELECT user_id FROM user_role WHERE role_id = ?', roleId).map((r) => r.user_id));
			for (const u of active) {
				if (held.has(u)) continue;
				b.run('INSERT INTO user_role (user_id, role_id, granted_at) VALUES (?, ?, ?)', u, roleId, b.at);
				granted++;
			}
		}
	}
	b.count('role: the four system roles are in place', SYSTEM_ROLES.length);
	b.count('user_role: Engineer and Quality granted to every active person', granted);
}

// ---------------------------------------------------------------- a7c1e0f4b2d9

function stepCallouts(b: Bridge): void {
	b.addColumn('procedure_step', 'callouts', 'JSON');
	if (b.columns('procedure_step').has('caution')) {
		let n = 0;
		for (const s of b.all<{ id: number; caution: string | null }>('SELECT id, caution FROM procedure_step')) {
			const text = (s.caution ?? '').trim();
			if (!text) continue;
			b.run('UPDATE procedure_step SET callouts = ? WHERE id = ?', JSON.stringify([{ kind: 'caution', text }]), s.id);
			n++;
		}
		b.count('procedure_step: caution moved to a callout', n);
		b.retire('procedure_step', 'caution', 'moved to callouts');
	}
}

// ---------------------------------------------------------------- b8d2f1a5c3e0

function templateNumber(b: Bridge): void {
	b.addColumn('master_procedure', 'template_number', 'VARCHAR(20)');
	const ids = b.all<{ id: number }>('SELECT id FROM master_procedure ORDER BY id').map((p) => p.id);
	ids.forEach((id, i) => b.run('UPDATE master_procedure SET template_number = ? WHERE id = ?', `T-${String(i + 1).padStart(4, '0')}`, id));
	b.count('master_procedure: numbered T-0001 upward', ids.length);
	if (!ids.length) return;
	b.run("DELETE FROM designator_sequence WHERE designator_type = 'T'");
	b.run("INSERT INTO designator_sequence (designator_type, last_value, created_at, updated_at) VALUES ('T', ?, ?, ?)", ids.length, b.at, b.at);
	b.count('designator_sequence: counter for T- numbers added', 1);
}

// ---------------------------------------------------------------- the steps

/**
 * One line from the oldest released head to LEGACY_HEAD. The Alembic graph has two diamonds
 * between 1.3.2 and 1.4.0-beta.1. No release stopped inside one, and the paths do not touch the
 * same columns, so any order is the same result. This is the order `alembic history` prints.
 */
const STEPS: { revision: string; title: string; apply?: (b: Bridge) => void; missing?: (b: Bridge) => boolean }[] = [
	{
		revision: 'bb285af00e88',
		title: 'step dependencies',
		apply: (b) => void b.run(`CREATE TABLE IF NOT EXISTS step_dependency (${ID}, step_id INTEGER NOT NULL, depends_on_step_id INTEGER NOT NULL, ${AT})`)
	},
	{ revision: 'eb217417d6d2', title: 'template-level attachments', apply: (b) => b.addColumn('attachment', 'procedure_id', 'INTEGER') },
	{ revision: 'a310ab9da1d8', title: 'attachment kind', apply: (b) => b.addColumn('attachment', 'kind', 'VARCHAR(20)') },
	{
		revision: '0c42f39a04cc',
		title: 'redline columns on step executions',
		apply: (b) => {
			b.addColumn('step_execution', 'ad_hoc_issue_id', 'INTEGER');
			b.addColumn('step_execution', 'ad_hoc_host_order', 'INTEGER');
			b.addColumn('step_execution', 'title', 'VARCHAR(255)');
			b.addColumn('step_execution', 'instructions', 'TEXT');
			b.addColumn('step_execution', 'required_data_schema', 'JSON');
			b.addColumn('step_execution', 'requires_signoff', 'BOOLEAN', '0');
		}
	},
	{
		revision: '8a5444d1e3e6',
		title: 'application settings',
		apply: (b) => void b.run(`CREATE TABLE IF NOT EXISTS app_setting (key VARCHAR(64) PRIMARY KEY, value TEXT, ${AT})`)
	},
	{
		revision: 'b3f1c2a9d4e7',
		title: 'step safety fields',
		apply: (b) => {
			b.addColumn('procedure_step', 'required_role', 'VARCHAR(50)');
			b.addColumn('procedure_step', 'caution', 'TEXT');
			b.addColumn('procedure_instance', 'target_entity', 'JSON');
		}
	},
	{
		revision: 'c4d5e6f7a8b9',
		title: 'supplier part numbers',
		apply: (b) => void b.run(`CREATE TABLE IF NOT EXISTS supplier_part (${ID}, supplier_id INTEGER NOT NULL, part_id INTEGER NOT NULL, vendor_pn VARCHAR(255) NOT NULL, is_preferred BOOLEAN NOT NULL, notes TEXT, ${AT})`)
	},
	{
		revision: 'd5e6f7a8b9c0',
		title: 'purchase expenses',
		apply: (b) => void b.run(`CREATE TABLE IF NOT EXISTS purchase_expense (${ID}, purchase_id INTEGER NOT NULL, purchase_line_id INTEGER, part_id INTEGER, quantity NUMERIC NOT NULL, unit_cost NUMERIC, total_cost NUMERIC, tier INTEGER, received_at DATETIME NOT NULL, notes TEXT, ${AT})`)
	},
	{
		revision: 'e6f7a8b9c0d1',
		title: 'requirements',
		apply: (b) => {
			b.run(`CREATE TABLE IF NOT EXISTS requirement (${ID}, req_number VARCHAR(20) NOT NULL, title VARCHAR(255) NOT NULL, statement TEXT NOT NULL, rationale TEXT, category VARCHAR(50), parent_id INTEGER, level INTEGER NOT NULL, verification_method VARCHAR(20), tbd BOOLEAN NOT NULL, tbr BOOLEAN NOT NULL, tbr_owner_id INTEGER, tbr_due DATETIME, lifecycle_state VARCHAR(20) NOT NULL, revision INTEGER NOT NULL, baselined_at DATETIME, baselined_by_id INTEGER, supersedes_id INTEGER, ${AT}, deleted_at DATETIME)`);
			b.addColumn('part_requirements', 'requirement_ref_id', 'INTEGER');
		}
	},
	{
		revision: '68618049950a',
		title: 'baseline events',
		apply: (b) => {
			b.run(`CREATE TABLE IF NOT EXISTS baseline_event (label VARCHAR(100), note TEXT, signed_by_id INTEGER, ${ID}, ${AT})`);
			b.run('CREATE TABLE IF NOT EXISTS baseline_event_item (event_id INTEGER NOT NULL, requirement_id INTEGER NOT NULL, id INTEGER PRIMARY KEY)');
		}
	},
	{ revision: '9ff91c5a4252', title: 'requirement staleness', apply: (b) => b.addColumn('requirement', 'stale', 'BOOLEAN', '0') },
	{ revision: 'b3f2c1d4a5e6', title: 'search index (left out, the server has its own)' },
	{ revision: 'f1e2d3c4b5a6', title: 'usernames, passwords, tokens and passkeys', apply: credentialedAuth },
	{ revision: 'ccf93c36170a', title: 'part lifecycle', apply: partLifecycle },
	{ revision: 'a7c41d92e803', title: 'issue containment and disposition signature', apply: issueContainment, missing: (b) => !b.columns('issue').has('containment') },
	{ revision: 'a7b9c1d3e5f7', title: 'risk scenarios and dispositions', apply: riskScenarios, missing: (b) => !b.columns('risk').has('disposition') },
	{ revision: '52973e130a6f', title: 'merge' },
	{
		revision: 'b3c5d7e9f1a2',
		title: 'part procurement',
		missing: (b) => !b.columns('part').has('procurement'),
		apply: (b) => {
			b.addColumn('part', 'procurement', 'VARCHAR(10)', "'make'");
			b.note('part: has an external part number, so it is bought', "UPDATE part SET procurement = 'buy' WHERE external_pn IS NOT NULL AND external_pn != ''");
		}
	},
	{
		revision: '26297a8e0c76',
		title: 'step focus, step images, capture attribution',
		missing: (b) => !b.columns('step_execution').has('first_focused_at'),
		apply: (b) => {
			b.run(`CREATE TABLE IF NOT EXISTS step_focus (${ID}, instance_id INTEGER NOT NULL, step_execution_id INTEGER NOT NULL, user_id INTEGER NOT NULL, focused_at DATETIME NOT NULL, ${AT})`);
			b.addColumn('step_execution', 'first_focused_at', 'DATETIME');
			b.run(`CREATE TABLE IF NOT EXISTS step_image (${ID}, step_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL, caption VARCHAR(255), position INTEGER NOT NULL, ${AT})`);
			b.addColumn('attachment', 'note', 'TEXT');
			b.addColumn('attachment', 'uploaded_by_id', 'INTEGER');
			b.addColumn('procedure_step', 'strict_sequence', 'BOOLEAN', '0');
		}
	},
	{
		revision: 'b3d1f0a2c4e6',
		title: 'work order statuses renamed',
		// Nothing has the old names once it has run, so running it again changes nothing.
		missing: () => true,
		apply: (b) => {
			b.note('procedure_instance: pending is now cut', "UPDATE procedure_instance SET status = 'cut' WHERE status = 'pending'");
			b.note('procedure_instance: in_progress is now in_work', "UPDATE procedure_instance SET status = 'in_work' WHERE status = 'in_progress'");
		}
	},
	{ revision: '894e35219894', title: 'merge' },
	{
		revision: 'c7a2e9d41f88',
		title: 'step notes',
		apply: (b) => {
			b.run(`CREATE TABLE IF NOT EXISTS step_note (${ID}, step_execution_id INTEGER NOT NULL, author_id INTEGER, body TEXT NOT NULL, ${AT})`);
			if (!b.columns('step_execution').has('notes')) return;
			b.note(
				'step_note: made from the notes on step executions',
				"INSERT INTO step_note (step_execution_id, author_id, body, created_at, updated_at) SELECT id, NULL, notes, COALESCE(completed_at, ?), COALESCE(completed_at, ?) FROM step_execution WHERE notes IS NOT NULL AND TRIM(notes) != ''",
				b.at,
				b.at
			);
			b.retire('step_execution', 'notes', 'moved to step_note');
		}
	},
	{ revision: 'd4e8b7a2c5f1', title: 'work order target entity retired', apply: (b) => b.retire('procedure_instance', 'target_entity', 'no longer used') },
	{ revision: 'b4b681fa39d7', title: 'API token expiry', apply: (b) => b.addColumn('api_token', 'expires_at', 'DATETIME') },
	{ revision: 'c1a2b3d4e5f6', title: 'passkey handshakes (left out, rows live 5 minutes)' },
	{
		revision: 'e7a1c93f2b48',
		title: 'exe.dev sign-in replaced by OIDC',
		apply: (b) => {
			b.addColumn('user', 'oidc_subject', 'VARCHAR(255)');
			b.addColumn('user', 'oidc_issuer', 'VARCHAR(255)');
			b.retire('user', 'exe_user_id', 'exe.dev sign-in was removed in 1.4.0-beta.3');
			b.note('app_setting: auth_mode and exe_proxy_secret removed', "DELETE FROM app_setting WHERE key IN ('auth_mode', 'exe_proxy_secret')");
		}
	},
	{ revision: 'd2c3b4a5e6f7', title: 'extension registry (left out, extensions are not imported)' },
	{
		revision: 'f3a9d2c8b501',
		title: 'notifications',
		apply: (b) => void b.run(`CREATE TABLE IF NOT EXISTS notification (${ID}, ${AT}, user_id INTEGER NOT NULL, actor_id INTEGER, kind VARCHAR(40) NOT NULL, priority VARCHAR(16) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT, href VARCHAR(500) NOT NULL, subject_type VARCHAR(40) NOT NULL, subject_id INTEGER NOT NULL, read_at DATETIME, dismissed_at DATETIME)`)
	},
	{ revision: 'a4c8e1d97b32', title: 'purchase order attachments', apply: (b) => b.addColumn('attachment', 'purchase_id', 'INTEGER') },
	{ revision: 'b7e41c0d9a52', title: 'sign-off slots and note files', apply: signoffSlots },
	{
		revision: 'c8d2e4f6a1b3',
		title: 'issue ticket stamps',
		apply: (b) => {
			for (const stamp of ['work_started', 'review_requested', 'closed']) {
				b.addColumn('issue', `${stamp}_at`, 'DATETIME');
				b.addColumn('issue', `${stamp}_by_id`, 'INTEGER');
			}
			b.note('issue: closed issue stamped closed at its last update', "UPDATE issue SET closed_at = updated_at WHERE status = 'closed'");
		}
	},
	{ revision: 'd5a7c3e91f40', title: 'roles and profile fields', apply: rolesAndProfile },
	{ revision: 'e6b8d4f2a903', title: 'system roles and permission gates', apply: systemRoles },
	{ revision: 'a7c1e0f4b2d9', title: 'step callouts', apply: stepCallouts },
	{ revision: LEGACY_HEAD, title: 'template numbers', apply: templateNumber }
];

const allTables = (db: Database): string[] =>
	(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

/** Nothing the bridge runs should ever reach another file, so if something did, stop before it counts. */
function assertOnlyMain(db: Database): void {
	const names = (db.query('PRAGMA database_list').all() as { name: string }[]).map((d) => d.name).filter((n) => n !== 'main' && n !== 'temp');
	if (names.length) throw new Error(`the file attached other databases (${names.join(', ')})`);
}

/**
 * The revisions a database can start from: the released heads, and whatever else lies on the line
 * between them. The stamp alone does not say what a file holds. Files stopped on one arm of a
 * diamond, and files made by `create_all` between releases, can be stamped past an arm they never
 * had, so each arm step also says how to see that it is missing.
 */
export const canBridge = (revision: string): boolean =>
	revision === '00d3ac121e5e' || STEPS.some((s) => s.revision === revision);

/**
 * Applies every step after `revision`, and any before it the file turns out to lack, in one transaction. `db` must be a private copy: it is
 * changed. Throws an error that names the step when one fails.
 */
export function bridgeToHead(db: Database, revision: string): BridgeReport {
	const first = revision === '00d3ac121e5e' ? 0 : STEPS.findIndex((s) => s.revision === revision) + 1;
	const before = new Set(allTables(db));
	const b = new Bridge(db);
	const report: BridgeReport = {
		from: revision,
		release: RELEASED_HEADS[revision] ?? 'between releases',
		to: LEGACY_HEAD,
		steps: [],
		createdTables: [],
		retiredColumns: b.retired
	};
	db.run('PRAGMA foreign_keys = OFF');
	db.run('BEGIN');
	let current = 'preparing';
	try {
		// FTS sync triggers would fire on every update below, and they fail on these databases.
		for (const t of db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) {
			db.query(`DROP TRIGGER ${ident(t.name)}`).run();
		}
		for (const [i, step] of STEPS.entries()) {
			const pastStamp = i < first;
			if (pastStamp && !step.missing?.(b)) continue;
			current = `${step.revision} (${step.title})`;
			b.changes = [];
			step.apply?.(b);
			report.steps.push({ revision: step.revision, title: step.title, changes: b.changes, ...(pastStamp && b.changes.length ? { pastStamp } : {}) });
		}
		current = 'retiring columns';
		b.dropRetiredColumns();
		db.query('UPDATE alembic_version SET version_num = ?').run(LEGACY_HEAD);
		assertOnlyMain(db);
		db.run('COMMIT');
	} catch (e) {
		db.run('ROLLBACK');
		throw new Error(`Could not bring this ${report.release} database forward, at step ${current}: ${e instanceof Error ? e.message : String(e)}. The file was not changed.`);
	}
	report.createdTables = allTables(db).filter((t) => !before.has(t)).sort();
	return report;
}
