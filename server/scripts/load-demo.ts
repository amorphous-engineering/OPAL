/**
 * Loads a demo dataset into a new data folder, through OPAL's own operations.
 *
 * Usage: bun scripts/load-demo.ts <new-data-dir> [dataset-dir]
 *        (every seeded person gets the password `sphinx-demo`, or OPAL_DEMO_PASSWORD if set)
 *
 * The dataset (default `demo/mojave-sphinx`) is a folder of YAML files and photos under its own
 * licence. Nothing here writes to the database directly: every record goes through the same
 * operation a person would use, as the person the dataset names, with the clock set to the time
 * it gives. A record the app would refuse stops the load.
 *
 * The clock is the process clock, moved with Bun's `setSystemTime`. It is set here only; the
 * server has no settable clock.
 */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const [dataDirArg, datasetArg] = process.argv.slice(2);
if (!dataDirArg) fail('usage: bun scripts/load-demo.ts <new-data-dir> [dataset-dir]');
const outDir = resolve(dataDirArg);
const dataset = resolve(datasetArg ?? join(import.meta.dir, '../../demo/mojave-sphinx'));
// One easy password for every seeded person: this is demo data. Ten characters is the app's minimum.
const password = process.env.OPAL_DEMO_PASSWORD ?? 'sphinx-demo';
if (existsSync(outDir) && readdirSync(outDir).length) fail(`${outDir} is not empty`);
mkdirSync(outDir, { recursive: true });

// Before the app loads: blobs, keys and the database all follow this folder.
process.env.OPAL_DATA_DIR = outDir;
delete process.env.OPAL_DB_FILE;

const { createApp } = await import('../src/app.ts');
const { CALLOUT_KINDS, convert } = await import('@opal/shared');
const { openDb } = await import('../src/db/client.ts');
const { dbPath } = await import('../src/paths.ts');
type Actor = import('../src/context.ts').Actor;

function fail(message: string): never {
	console.error(`load-demo: ${message}`);
	process.exit(1);
}

// ---------------------------------------------------------------- dataset files

type Rec = Record<string, any>;

const yaml = (file: string): Rec => {
	const path = join(dataset, file);
	if (!existsSync(path)) fail(`${file} is missing from ${dataset}`);
	return Bun.YAML.parse(readFileSync(path, 'utf8')) as Rec;
};

/**
 * Text blocks are written wrapped. The app shows a single newline as a line break, so the lines
 * of a paragraph are joined here. In a list, a wrapped line is joined to its item. A table or a
 * quote keeps its lines.
 */
function reflow(text: string | null | undefined): string | null {
	if (text === null || text === undefined) return null;
	const item = /^\s*([-*+]|\d+\.)\s/;
	return text
		.trim()
		.split(/\n\s*\n/)
		.map((p) => {
			if (/^\s*(\||>)/m.test(p)) return p.trimEnd();
			if (!item.test(p.split('\n')[0]!) && !p.split('\n').some((l) => item.test(l))) return p.replace(/\s*\n\s*/g, ' ').trim();
			const lines: string[] = [];
			for (const l of p.split('\n')) {
				if (item.test(l) || !lines.length) lines.push(l.trimEnd());
				else lines[lines.length - 1] += ` ${l.trim()}`;
			}
			return lines.join('\n');
		})
		.join('\n\n');
}

const org = yaml('org.yaml');
const partsFile = yaml('parts.yaml');
const requirementsFile = yaml('requirements.yaml');
const datasetsFile = yaml('datasets.yaml');
const story = yaml('story.yaml');
const procedures = readdirSync(join(dataset, 'procedures'))
	.filter((f) => f.endsWith('.yaml'))
	.sort()
	.map((f) => yaml(join('procedures', f)));

// ---------------------------------------------------------------- the app, one actor at a time

const db = openDb(dbPath());
let current: Actor = { kind: 'anonymous' };
const app = createApp({ db, resolveActor: () => current });

let clock = Date.parse(org.founded ?? story.events[0].at);
if (Number.isNaN(clock)) fail('org.yaml needs `founded`, an ISO 8601 time');
/** Move the clock to a stated time. It never runs backwards. */
function at(time: string | undefined): void {
	if (!time) return;
	const t = Date.parse(time);
	if (Number.isNaN(t)) fail(`not a time: ${time}`);
	if (t < clock) fail(`${time} is earlier than the event before it`);
	clock = t;
}

const people = new Map<string, Actor>();
const as = (key: string): Actor => people.get(key) ?? fail(`no person '${key}' in org.yaml`);

let calls = 0;
/** One request. Every write lands a few seconds after the one before it. */
async function call(by: Actor, method: string, path: string, body?: unknown): Promise<any> {
	if (method !== 'GET') clock += 4000;
	setSystemTime(new Date(clock));
	current = by;
	const form = body instanceof FormData;
	const res = await app.request(`/api${path}`, {
		method,
		headers: body === undefined || form ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : form ? body : JSON.stringify(body)
	});
	const text = await res.text();
	if (res.status >= 300) fail(`${method} ${path} -> ${res.status} ${text}\n  sent: ${form ? '(form)' : JSON.stringify(body)}`);
	calls++;
	return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- organization

const first = org.people[0];
const admin = await call({ kind: 'anonymous' }, 'POST', '/auth/setup', {
	username: first.username,
	name: first.name,
	email: first.email,
	password
});
const adminId: number = admin.user?.id ?? admin.id;
people.set(first.key, { kind: 'user', userId: adminId, isAdmin: true, sessionId: 0 });
const boss = as(first.key);

await call(boss, 'POST', '/settings/organization', {
	name: org.organization.name,
	description: org.organization.description ?? '',
	tiers: org.organization.tiers.map((t: Rec) => ({
		level: t.level,
		name: t.name,
		code: t.code,
		description: t.description ?? '',
		defaultTracking: t.default_tracking ?? null,
		requireLot: t.require_lot ?? null,
		autoSerial: t.auto_serial ?? null
	})),
	partNumbering: {
		prefix: org.organization.part_numbering.prefix,
		separator: org.organization.part_numbering.separator ?? '-',
		sequenceDigits: org.organization.part_numbering.sequence_digits ?? 4
	},
	categories: org.organization.categories ?? []
});
const tierLevel = new Map<string, number>(org.organization.tiers.map((t: Rec) => [t.name, t.level]));

// Before the roles: a crew role belongs to the project.
const project = await call(boss, 'POST', '/projects', org.project);

const roleId = new Map<string, number>();
for (const r of (await call(boss, 'GET', '/roles')) as Rec[]) roleId.set(r.name, r.id);
for (const r of org.roles ?? []) {
	// `code` and `color` are the role's mark on a step; left out, the app picks initials and a colour.
	const mark = { ...(r.code ? { code: r.code } : {}), ...(r.color ? { color: r.color } : {}) };
	// `project: true` makes it a role of the project: offered in its procedures, passing no gate.
	const scope = r.project ? { projectId: project.id } : {};
	if (!roleId.has(r.name)) roleId.set(r.name, (await call(boss, 'POST', '/roles', { name: r.name, description: r.description ?? null, ...scope, ...mark })).id);
	else if (r.code || r.color) await call(boss, 'PATCH', `/roles/${roleId.get(r.name)}`, mark);
}
for (const p of org.people) {
	let id = adminId;
	if (p !== first) {
		// Everyone gets the one demo password, so a second person can sign in to give a second sign-off.
		id = (await call(boss, 'POST', '/users', { name: p.name, username: p.username, email: p.email ?? null, password })).id;
		people.set(p.key, { kind: 'user', userId: id, isAdmin: false, sessionId: 0 });
	}
	const ids = (p.roles ?? []).map((n: string) => roleId.get(n) ?? fail(`no role '${n}'`));
	// The first person keeps Admin, which first-run setup gave.
	if (p === first && roleId.has('Admin')) ids.push(roleId.get('Admin')!);
	if (ids.length) await call(boss, 'PUT', `/users/${id}/roles`, { roleIds: ids });
}

for (const [gate, names] of Object.entries((org.gates ?? {}) as Record<string, string[]>)) {
	await call(boss, 'PUT', `/gates/${gate}`, { roleIds: names.map((n) => roleId.get(n) ?? fail(`no role '${n}'`)) });
}

const workcenterId = new Map<string, number>();
for (const w of org.workcenters ?? []) workcenterId.set(w.code, (await call(boss, 'POST', '/workcenters', w)).id);
const supplierId = new Map<string, number>();
for (const s of org.suppliers ?? []) {
	const { key, ...fields } = s;
	supplierId.set(key, (await call(boss, 'POST', '/suppliers', fields)).id);
}

// ---------------------------------------------------------------- parts

const part = new Map<string, Rec>();
const partOf = (key: string): Rec => part.get(key) ?? fail(`no part '${key}' in parts.yaml`);

for (const p of partsFile.parts) {
	const created = await call(boss, 'POST', '/parts', {
		name: p.name,
		tier: tierLevel.get(p.tier) ?? fail(`no tier '${p.tier}'`),
		unitOfMeasure: p.unit ?? 'ea',
		trackingType: p.tracking,
		procurement: p.procurement,
		externalPn: p.external_pn ?? null,
		description: reflow(p.description),
		category: p.category ?? null,
		isTooling: p.tooling ?? false
	});
	part.set(p.key, created);
	// A catalog entry needs the vendor's number; a part bought by description alone has none.
	const vendorPn = p.supplier?.vendor_pn ?? (p.supplier ? p.external_pn : undefined);
	if (p.supplier && vendorPn) {
		await call(boss, 'POST', `/suppliers/${supplierId.get(p.supplier.key) ?? fail(`no supplier '${p.supplier.key}'`)}/parts`, {
			partId: created.id,
			vendorPn: String(vendorPn),
			isPreferred: true
		});
	}
}
for (const p of partsFile.parts) {
	for (const line of p.bom ?? []) {
		await call(boss, 'POST', `/parts/${partOf(p.key).id}/bom`, {
			componentId: partOf(line.part).id,
			quantity: String(line.quantity),
			notes: line.notes ?? null
		});
	}
}
// The file holds finished part definitions, so each is activated as soon as its bill of material is in.
for (const p of partsFile.parts) await call(boss, 'POST', `/parts/${partOf(p.key).id}/activate`, { cause: 'Released for build' });

// ---------------------------------------------------------------- procedures (drafts)

const procedure = new Map<string, Rec>();
const procedureOf = (key: string): Rec => procedure.get(key) ?? fail(`no procedure '${key}'`);

async function addImages(procedureId: number, stepId: number, images: Rec[] | undefined) {
	for (const img of images ?? []) {
		const path = join(dataset, img.file);
		const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(path).toLowerCase()];
		if (!type || !existsSync(path)) fail(`image ${img.file}: missing, or not a PNG or JPEG`);
		const form = new FormData();
		form.set('file', new File([readFileSync(path)], basename(path), { type }));
		if (img.caption) form.set('caption', img.caption);
		await call(boss, 'POST', `/procedures/${procedureId}/steps/${stepId}/images`, form);
	}
}

const stepFields = (s: Rec) => ({
	title: s.title,
	instructions: reflow(s.instructions),
	callouts: (s.callouts ?? []).map((c: Rec) => {
		const kind = Object.keys(c)[0]!;
		if (!(CALLOUT_KINDS as readonly string[]).includes(kind)) fail(`'${s.title}': no callout kind '${kind}'`);
		return { kind, text: reflow(c[kind]) };
	}),
	dataSchema: s.data ? { fields: s.data } : null,
	workcenterId: s.workcenter ? (workcenterId.get(s.workcenter) ?? fail(`no workcenter '${s.workcenter}'`)) : null,
	...(s.signoffs ? { signoffs: s.signoffs } : {}),
	...(s.strict_sequence ? { strictSequence: true } : {}),
	// The role that does the step, shown as its mark. It gates nothing.
	...(s.performer ? { performer: s.performer } : {}),
	// Unit slots: the serialized units an operation acts on, named when the work order is run.
	...(s.units
		? { units: s.units.map((u: Rec) => ({ key: u.key, label: u.label, partId: partOf(u.part).id, required: u.required ?? false })) }
		: {})
});

/** Every kit line of a procedure file: the procedure's own, then each step's. */
const kitLines = (p: Rec): Rec[] => [...(p.kit ?? []), ...(p.operations as Rec[]).flatMap((o) => ((o.steps ?? []) as Rec[]).flatMap((x) => (x.kit ?? []) as Rec[]))];

// A kit quantity is in the part's own unit. A line may state another unit of the same kind
// (3.75 in of tubing stocked by the foot), which is converted here.
function kitQty(owner: string, k: Rec): string {
	const unit = partOf(k.part).unitOfMeasure as string;
	if (!k.unit || k.unit === unit) return String(k.quantity);
	try {
		return String(Number(convert(Number(k.quantity), k.unit, unit).toFixed(4)));
	} catch {
		return fail(`${owner}: kit gives '${k.part}' in ${k.unit}, but the part is stocked in ${unit}. Set its unit in parts.yaml.`);
	}
}

for (const p of procedures) {
	const created = await call(boss, 'POST', '/procedures', {
		projectId: project.id,
		name: p.name,
		description: reflow(p.description),
		procedureType: p.type
	});
	procedure.set(p.key, created);
	const opIds: number[] = [];
	for (const o of p.operations) {
		const op = await call(boss, 'POST', `/procedures/${created.id}/steps`, { ...stepFields(o), isContingency: o.contingency ?? false });
		opIds.push(op.id);
		// `depends_on` counts operations of this file from 1.
		if (o.depends_on) {
			const dependsOn = o.depends_on.map((n: number) => opIds[n - 1] ?? fail(`${p.key}: operation '${o.title}' depends on operation ${n}, which is not before it`));
			await call(boss, 'PUT', `/procedures/${created.id}/steps/${op.id}/dependencies`, { dependsOn });
		}
		await addImages(created.id, op.id, o.images);
		for (const s of o.steps ?? []) {
			const step = await call(boss, 'POST', `/procedures/${created.id}/steps`, { ...stepFields(s), parentId: op.id });
			await addImages(created.id, step.id, s.images);
			for (const k of s.kit ?? []) {
				await call(boss, 'POST', `/procedures/${created.id}/steps/${step.id}/kit`, {
					partId: partOf(k.part).id,
					quantity: kitQty(p.key, k),
					usage: k.usage ?? 'consume',
					// A slot key of this procedure: consuming the line installs the part into that unit.
					...(k.into ? { into: k.into } : {})
				});
			}
		}
	}
	// The outputs first: OPAL puts each output's bill of material into the kit. A kit line the
	// file also states must then agree with the bills of material, and only the rest is added.
	const outputs: Rec[] = p.outputs ?? (p.output ? [p.output] : []);
	if (p.type !== 'build' && outputs.length) fail(`${p.key}: only a build has outputs`);
	for (const [n, o] of outputs.entries()) {
		if (Number(o.quantity ?? 1) !== 1) fail(`${p.key}: an output quantity other than 1 is not handled`);
		// An output with no bill of material in parts.yaml takes the consumed kit lines as one:
		// the guidebook's parts list is then the only place the quantities are written. With
		// several outputs, a kit line says which it goes into with `for`; the rest go into the first.
		const outputId = partOf(o.part).id;
		if (!((await call(boss, 'GET', `/parts/${outputId}/bom`)) as Rec[]).length) {
			const mine = (p.kit ?? []).filter((x: Rec) => (x.usage ?? 'consume') === 'consume' && (x.for ? x.for === o.part : n === 0));
			for (const k of mine) {
				await call(boss, 'POST', `/parts/${outputId}/bom`, { componentId: partOf(k.part).id, quantity: kitQty(p.key, k) });
			}
		}
		await call(boss, 'POST', `/procedures/${created.id}/outputs`, { partId: outputId, quantity: '1' });
	}
	const fromBom = new Map<number, Rec>(((await call(boss, 'GET', `/procedures/${created.id}/kit`)) as Rec[]).map((k) => [k.partId, k]));
	// The file may state one part on several lines (half a tube into each of two products).
	const stated = new Map<string, { part: string; usage: string; quantity: number }>();
	for (const k of p.kit ?? []) {
		const usage = k.usage ?? 'consume';
		const line = stated.get(`${k.part}:${usage}`) ?? { part: k.part, usage, quantity: 0 };
		line.quantity = Number((line.quantity + Number(kitQty(p.key, k))).toFixed(4));
		stated.set(`${k.part}:${usage}`, line);
	}
	for (const k of stated.values()) {
		const have = fromBom.get(partOf(k.part).id);
		if (have) {
			if (Number(have.quantity) !== k.quantity || have.usage !== k.usage) {
				fail(`${p.key}: kit says ${k.quantity} ${k.usage} of '${k.part}', the output's bill of material gives ${have.quantity} ${have.usage}`);
			}
			continue;
		}
		await call(boss, 'POST', `/procedures/${created.id}/kit`, { partId: partOf(k.part).id, quantity: String(k.quantity), usage: k.usage });
	}
}

// ---------------------------------------------------------------- requirements (drafts)

const requirement = new Map<string, Rec>();
const requirementOf = (key: string): Rec => requirement.get(key) ?? fail(`no requirement '${key}'`);
/** Allocation ids by `requirement key:part key`. */
const allocation = new Map<string, number>();

for (const r of requirementsFile.requirements) {
	const created = await call(boss, 'POST', '/requirements', {
		projectId: project.id,
		title: r.title,
		statement: reflow(r.statement),
		rationale: reflow(r.rationale),
		category: r.category ?? null,
		parentId: r.parent ? requirementOf(r.parent).id : null,
		verificationMethod: r.verification ?? null,
		tbd: r.tbd ?? false,
		tbr: !!r.tbr,
		tbrOwnerId: r.tbr ? (as(r.tbr.owner) as { userId: number }).userId : null,
		tbrDue: r.tbr?.due ?? null
	});
	requirement.set(r.key, created);
	for (const a of r.allocations ?? []) {
		const link = await call(boss, 'POST', `/requirements/parts/${partOf(a.part).id}`, {
			reqNumber: created.reqNumber,
			notes: reflow(a.notes)
		});
		allocation.set(`${r.key}:${a.part}`, link.id);
	}
}

// ---------------------------------------------------------------- the story

const order = new Map<string, Rec>();
const workOrder = new Map<string, Rec>();
/** `{key}` in a note becomes the number OPAL gave that order or work order. */
const named = (text: string | undefined): string | null =>
	reflow(text)?.replace(/\{([\w-]+)\}/g, (_m, k: string) => workOrder.get(k)?.woNumber ?? order.get(k)?.reference ?? issue.get(k)?.issueNumber ?? risk.get(k)?.riskNumber ?? fail(`no record '${k}' yet`)) ?? null;

const procFile = new Map<string, Rec>(procedures.map((p: Rec) => [p.key, p]));
const partYaml = new Map<string, Rec>(partsFile.parts.map((p: Rec) => [p.key, p]));
/** Parts a procedure in this dataset makes. Everything else is bought, or made with no procedure. */
const builtParts = new Set<string>(procedures.flatMap((p: Rec) => (p.outputs ?? (p.output ? [p.output] : [])).map((o: Rec) => o.part)));
const issue = new Map<string, Rec>();
const issueOf = (key: string): Rec => issue.get(key) ?? fail(`no issue '${key}' yet`);
const risk = new Map<string, Rec>();
const dataSet = new Map<string, Rec>();
const riskOf = (key: string): Rec => risk.get(key) ?? fail(`no risk '${key}' yet`);
const userId = (key: string): number => (as(key) as { userId: number }).userId;

/** One procedure's kit, one line per part and usage, in the part's own unit. */
function kitOf(key: string): { part: string; usage: 'consume' | 'tooling'; quantity: number; into?: string }[] {
	const p = procFile.get(key) ?? fail(`no procedure '${key}'`);
	const lines = new Map<string, { part: string; usage: 'consume' | 'tooling'; quantity: number; into?: string }>();
	for (const k of kitLines(p)) {
		const usage = k.usage ?? 'consume';
		const line = lines.get(`${k.part}:${usage}:${k.into ?? ''}`) ?? { part: k.part, usage, quantity: 0, ...(k.into ? { into: k.into } : {}) };
		line.quantity = Number((line.quantity + Number(kitQty(key, k))).toFixed(4));
		lines.set(`${k.part}:${usage}:${k.into ?? ''}`, line);
	}
	return [...lines.values()];
}

/**
 * What a list of procedures draws from stock. An entry is a procedure key, or
 * `{ procedure, times }` for one that is run more than once. Consumed quantities add up. A tool
 * is counted once, at the most any one procedure uses.
 */
function needs(list: (string | Rec)[]): Map<string, number> {
	const consumed = new Map<string, number>();
	const tools = new Map<string, number>();
	for (const entry of list) {
		const key = typeof entry === 'string' ? entry : entry.procedure;
		const times = typeof entry === 'string' ? 1 : Number(entry.times ?? 1);
		for (const k of kitOf(key)) {
			if (k.usage === 'tooling') tools.set(k.part, Math.max(tools.get(k.part) ?? 0, k.quantity));
			else consumed.set(k.part, (consumed.get(k.part) ?? 0) + k.quantity * times);
		}
	}
	for (const [k, q] of tools) consumed.set(k, (consumed.get(k) ?? 0) + q);
	return consumed;
}

/** Stock records that together hold a quantity of a part, oldest first. */
async function stocksFor(by: Actor, partKey: string, quantity: number): Promise<{ stockId: number; quantity: string }[]> {
	const page = await call(by, 'GET', `/inventory?partId=${partOf(partKey).id}&hasStock=1&sort=createdAt&limit=100`);
	const picks: { stockId: number; quantity: string }[] = [];
	let left = quantity;
	for (const s of page.items as Rec[]) {
		if (left <= 0) break;
		const take = Math.min(left, Number(s.balance));
		if (take <= 0) continue;
		picks.push({ stockId: s.id, quantity: String(Number(take.toFixed(4))) });
		left = Number((left - take).toFixed(4));
	}
	if (left > 0) fail(`stock is ${left} short of ${quantity} of '${partKey}'`);
	return picks;
}

/** Minutes a step takes: the pace, varied by the step number so the times do not look ruled. */
const spread = (pace: number, n: number) => Math.round(pace * (0.6 + ((n * 37) % 9) / 10) * 60_000);

/** What each finished build booked into stock, by the work order's key. */
const product = new Map<string, Rec[]>();

const handlers: Record<string, (by: Actor, e: Rec) => Promise<void>> = {
	/** `lines` as given, or with `for`: every part the supplier sells that those procedures draw. */
	async order(by, e) {
		let lines: Rec[] = (e.lines ?? []).map((l: Rec) => ({ partId: partOf(l.part).id, qtyOrdered: String(l.quantity), unitCost: l.unit_cost ?? null }));
		if (e.for) {
			for (const [key, need] of needs(e.for)) {
				const y = partYaml.get(key)!;
				if (y.procurement !== 'buy' || builtParts.has(key) || (e.skip ?? []).includes(key)) continue;
				// A part with no supplier on file is bought over the counter.
				if ((y.supplier?.key ?? 'retail-store') !== e.supplier) continue;
				// Sold in packs: whole packs are ordered, and the price on file is the pack's.
				const pack = Number(y.supplier?.pack ?? 1);
				const quantity = Math.ceil(need / pack) * pack;
				const price = y.supplier?.price ? String(Number((Number(y.supplier.price) / pack).toFixed(4))) : null;
				lines.push({ partId: partOf(key).id, qtyOrdered: String(quantity), unitCost: price });
			}
		}
		if (!lines.length) fail(`order '${e.key}': no lines`);
		const po = await call(by, 'POST', '/purchases', {
			supplierId: supplierId.get(e.supplier) ?? fail(`no supplier '${e.supplier}'`),
			destination: e.destination ?? null,
			notes: e.notes ?? null,
			lines
		});
		order.set(e.key, await call(by, 'POST', `/purchases/${po.id}/place`, {}));
	},
	/** `lines` as given, or `all: true` for everything still owed. `short` names what came in short: part key to quantity received. */
	async receive(by, e) {
		const po = order.get(e.order) ?? fail(`no order '${e.order}'`);
		let lines: Rec[];
		if (e.all) {
			const short = new Map<number, number>(Object.entries(e.short ?? {}).map(([k, q]) => [partOf(k).id as number, Number(q)]));
			lines = (po.lines as Rec[])
				.map((l) => {
					const owed = Number(l.qtyOrdered) - Number(l.qtyReceived ?? 0);
					return { lineId: l.id, quantity: String(short.has(l.partId) ? short.get(l.partId) : owed), location: e.location ?? null };
				})
				.filter((l) => Number(l.quantity) > 0);
		} else {
			lines = e.lines.map((l: Rec) => {
				const line = (po.lines as Rec[]).find((x) => x.partId === partOf(l.part).id) ?? fail(`order '${e.order}' has no line for '${l.part}'`);
				return { lineId: line.id, quantity: String(l.quantity), location: e.location ?? null };
			});
		}
		order.set(e.order, await call(by, 'POST', `/purchases/${po.id}/receive`, { lines }));
	},
	async stock(by, e) {
		await call(by, 'POST', '/inventory', {
			partId: partOf(e.part).id,
			quantity: String(e.quantity),
			location: e.location,
			lotNumber: e.lot ?? null
		});
	},
	/** Parts the team makes with no procedure in this dataset (printed, machined, cut): booked into stock as one lot. */
	async make(by, e) {
		for (const [key, need] of needs(e.for)) {
			const y = partYaml.get(key)!;
			if (y.procurement !== 'make' || builtParts.has(key) || (e.skip ?? []).includes(key)) continue;
			if (e.only && !e.only.includes(key)) continue;
			const serial = partOf(key).trackingType === 'serialized';
			for (let n = 0; n < (serial ? Math.ceil(need) : 1); n++) {
				await call(by, 'POST', '/inventory', {
					partId: partOf(key).id,
					quantity: serial ? '1' : String(Math.ceil(need)),
					location: e.location,
					lotNumber: serial ? null : (e.lot ?? null)
				});
			}
		}
	},
	async publish(by, e) {
		const keys: string[] = e.all ? procedures.map((p: Rec) => p.key) : (e.procedures ?? [e.procedure]);
		for (const k of keys) await call(by, 'POST', `/procedures/${procedureOf(k).id}/publish`, { changeNote: e.note ?? null });
	},
	async baseline(by, e) {
		await call(by, 'POST', '/requirements/baseline-batch', {
			ids: e.requirements.map((k: string) => requirementOf(k).id),
			label: e.label ?? null,
			note: named(e.note)
		});
	},
	async cut(by, e) {
		workOrder.set(e.key, { ...(await call(by, 'POST', '/executions', { procedureId: procedureOf(e.procedure).id })), procedureKey: e.procedure });
	},
	async work(by, e) {
		const wo = workOrder.get(e.order) ?? fail(`no work order '${e.order}'`);
		if (e.kit) {
			at(e.kit.at);
			const items: Rec[] = [];
			for (const usage of ['consume', 'tooling'] as const) {
				for (const k of e.kit[usage] ?? []) {
					for (const pick of await stocksFor(by, k.part, Number(k.quantity))) items.push({ ...pick, usage });
				}
			}
			await call(by, 'POST', `/executions/${wo.id}/consume`, { items });
		}
		for (const s of e.steps ?? []) {
			at(s.at);
			// `after`: minutes since the event before, where a stated time would only be a guess.
			if (s.after) clock += Number(s.after) * 60_000;
			const steps = (await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[];
			const row = steps.find((x) => x.number === String(s.step)) ?? fail(`${wo.woNumber} has no step ${s.step}`);
			await call(by, 'POST', `/executions/${wo.id}/steps/${row.id}/complete`, {
				dataCaptured: s.data ?? null,
				notes: named(s.note)
			});
		}
		if (e.finish) {
			at(e.finish.at);
			await call(by, 'POST', `/executions/${wo.id}/finalize`, { location: e.finish.location, notes: named(e.finish.note) });
		}
		workOrder.set(e.order, { ...(await call(by, 'GET', `/executions/${wo.id}`)), procedureKey: wo.procedureKey });
	},
	/**
	 * A work order run in one go: cut it, draw the whole kit, complete the steps in order `pace`
	 * minutes apart, and book the product into `location`. `pause_before` stops ahead of a step and
	 * leaves the work order open; a later `build` with the same key picks it up. `data` and `notes`
	 * are keyed by step number. `second` is the person who gives a second sign-off. `removals`, keyed
	 * by step number, takes components out of a unit the work order acts on, before that step.
	 */
	async build(by, e) {
		let wo = workOrder.get(e.key);
		if (!wo) {
			wo = (await call(by, 'POST', '/executions', { procedureId: procedureOf(e.procedure).id })) as Rec;
			workOrder.set(e.key, { ...wo, procedureKey: e.procedure });
			clock += 6 * 60_000;
			// `units` names the product of an earlier work order in a slot, on the OP that declares it.
			for (const [slot, from] of Object.entries((e.units ?? {}) as Record<string, string>)) {
				const ops = (procFile.get(e.procedure)!.operations as Rec[]).filter((o) => !o.contingency);
				const at = ops.findIndex((o) => ((o.units ?? []) as Rec[]).some((u) => u.key === slot));
				const declared = at < 0 ? fail(`${e.procedure}: no unit slot '${slot}'`) : (ops[at]!.units as Rec[]).find((u) => u.key === slot)!;
				const unit = (product.get(from) ?? fail(`'${from}' has made nothing yet`)).find((x) => x.partId === partOf(declared.part).id) ?? fail(`'${from}' did not make a ${declared.part}`);
				const opRow = ((await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[]).find((x) => String(x.number) === String(at + 1))!;
				await call(by, 'POST', `/executions/${wo.id}/steps/${opRow.id}/units`, { slot, stockId: unit.stockId });
			}
			const items: Rec[] = [];
			for (const k of kitOf(e.procedure)) {
				for (const pick of await stocksFor(by, k.part, k.quantity)) items.push({ ...pick, usage: k.usage, ...(k.into ? { into: k.into } : {}) });
			}
			if (items.length) await call(by, 'POST', `/executions/${wo.id}/consume`, { items });
		}
		const pace = Number(e.pace ?? 12);
		const file = procFile.get(workOrder.get(e.key)!.procedureKey)!;
		const signs = (file.operations as Rec[]).some((o) => o.signoffs?.length || ((o.steps ?? []) as Rec[]).some((x) => x.signoffs?.length));
		// The steps a person completes: every row with no row under it. Contingency operations are not run.
		const every = (await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[];
		const rows = every.filter((x) => !String(x.number).startsWith('C') && !every.some((y) => String(y.number).startsWith(`${x.number}.`)));
		let done = true;
		for (const [n, row] of rows.entries()) {
			if (row.status === 'completed' || row.status === 'skipped') continue;
			if (String(e.pause_before ?? '') === String(row.number)) {
				done = false;
				break;
			}
			clock += spread(pace, n + 1);
			for (const r of (e.removals?.[row.number] ?? []) as Rec[]) {
				const unit = ((await call(by, 'GET', `/executions/${wo.id}/units`)).units as Rec[]).find((u) => u.slot === r.slot) ?? fail(`${wo.woNumber}: no unit in slot '${r.slot}'`);
				let left = Number(r.quantity);
				for (const c of ((await call(by, 'GET', `/executions/${wo.id}/units/${unit.id}/components`)) as Rec[]).filter((c) => c.partId === partOf(r.part).id)) {
					if (left <= 0) break;
					const take = Math.min(left, Number(c.quantity));
					await call(by, 'POST', `/executions/${wo.id}/steps/${row.id}/removals`, { unitId: unit.id, stockId: c.stockId, quantity: String(take), notes: named(r.note) });
					left = Number((left - take).toFixed(4));
				}
				if (left > 0) fail(`${wo.woNumber} step ${row.number}: ${left} of '${r.part}' to remove is not in the unit`);
			}
			await call(by, 'POST', `/executions/${wo.id}/steps/${row.id}/complete`, {
				dataCaptured: e.data?.[row.number] ?? null,
				notes: named(e.notes?.[row.number])
			});
			// Sign-offs the completion leaves open: a second slot on the step goes to `second`, and an
			// operation's own sign-off to the person running the work order.
			if (!signs) continue;
			for (const w of ((await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[]).filter((x) => x.status === 'awaiting_signoff')) {
				const who = w.id === row.id ? as(e.second ?? fail(`${wo.woNumber} step ${row.number} needs a second person: give 'second'`)) : by;
				await call(who, 'POST', `/executions/${wo.id}/steps/${w.id}/signoff`, {});
			}
		}
		if (done && e.location) {
			clock += 5 * 60_000;
			const made = await call(by, 'POST', `/executions/${wo.id}/finalize`, { location: e.location, notes: named(e.finish_note) });
			product.set(e.key, made.productions as Rec[]);
		}
		workOrder.set(e.key, { ...(await call(by, 'GET', `/executions/${wo.id}`)), procedureKey: workOrder.get(e.key)!.procedureKey });
	},
	/** A non-conformance raised from a step of a work order. */
	async raise(by, e) {
		const wo = workOrder.get(e.order) ?? fail(`no work order '${e.order}'`);
		const steps = (await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[];
		const row = steps.find((x) => x.number === String(e.step)) ?? fail(`${wo.woNumber} has no step ${e.step}`);
		issue.set(
			e.key,
			await call(by, 'POST', `/executions/${wo.id}/steps/${row.id}/nc`, {
				title: e.title,
				description: named(e.description),
				priority: e.priority ?? 'medium',
				shouldBe: named(e.should_be),
				actual: named(e.actual),
				containment: e.containment ?? 'step',
				// `boundary`: a later step the issue holds, in place of the one it was raised on.
				containmentStepId: e.boundary ? (steps.find((x) => x.number === String(e.boundary)) ?? fail(`${wo.woNumber} has no step ${e.boundary}`)).id : null,
				assignedToId: e.assign ? userId(e.assign) : null
			})
		);
	},
	/** An issue of any type. `order` and `step` tie it to a work order step; without them it is raised away from the floor. */
	async issue(by, e) {
		const wo = e.order ? (workOrder.get(e.order) ?? fail(`no work order '${e.order}'`)) : null;
		const steps = wo ? ((await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[]) : [];
		const stepId = (n: unknown) => (n ? (steps.find((x) => x.number === String(n)) ?? fail(`${wo?.woNumber} has no step ${n}`)).id : null);
		issue.set(
			e.key,
			await call(by, 'POST', '/issues', {
				projectId: project.id,
				title: e.title,
				description: named(e.description),
				issueType: e.type ?? 'task',
				priority: e.priority ?? 'medium',
				shouldBe: named(e.should_be),
				actual: named(e.actual),
				expectedBenefit: named(e.expected_benefit),
				containment: e.containment ?? 'advisory',
				executionId: wo?.id ?? null,
				raisedStepId: stepId(e.step),
				containmentStepId: stepId(e.boundary),
				assignedToId: e.assign ? userId(e.assign) : null,
				links: (e.parts ?? []).map((k: string) => ({ kind: 'part', targetId: partOf(k).id }))
			})
		);
	},
	async comment(by, e) {
		await call(by, 'POST', `/issues/${issueOf(e.issue).id}/comments`, { body: named(e.text) });
	},
	/** Root cause and corrective action are written in; the disposition is then signed. */
	async disposition(by, e) {
		const id = issueOf(e.issue).id;
		if (e.root_cause || e.corrective_action) {
			await call(by, 'PATCH', `/issues/${id}`, { rootCause: named(e.root_cause), correctiveAction: named(e.corrective_action) });
		}
		issue.set(e.issue, await call(by, 'POST', `/issues/${id}/disposition`, { dispositionType: e.type, dispositionRationale: named(e.rationale) }));
	},
	/** What was found, written on an issue that takes no disposition. */
	async findings(by, e) {
		issue.set(e.issue, await call(by, 'PATCH', `/issues/${issueOf(e.issue).id}`, { rootCause: named(e.root_cause), correctiveAction: named(e.corrective_action) }));
	},
	async close(by, e) {
		issue.set(e.issue, await call(by, 'PATCH', `/issues/${issueOf(e.issue).id}`, { status: 'closed' }));
	},
	/** Ticket progress for an issue that takes no disposition: pending, in work, in review. */
	async start(by, e) {
		issue.set(e.issue, await call(by, 'POST', `/issues/${issueOf(e.issue).id}/start`, {}));
	},
	async review(by, e) {
		issue.set(e.issue, await call(by, 'POST', `/issues/${issueOf(e.issue).id}/review`, {}));
	},
	/** A started work order that cannot finish: closed short, citing an issue raised on it. */
	async close_short(by, e) {
		const wo = workOrder.get(e.order) ?? fail(`no work order '${e.order}'`);
		await call(by, 'POST', `/executions/${wo.id}/close-short`, { reason: named(e.reason), issueId: issueOf(e.issue).id });
		workOrder.set(e.order, { ...(await call(by, 'GET', `/executions/${wo.id}`)), procedureKey: wo.procedureKey });
	},
	/** A requirement written during the story. It stays a draft until a `baseline` event. */
	async requirement(by, e) {
		const created = await call(by, 'POST', '/requirements', {
			projectId: project.id,
			title: e.title,
			statement: reflow(e.statement),
			rationale: named(e.rationale),
			category: e.category ?? null,
			parentId: e.parent ? requirementOf(e.parent).id : null,
			verificationMethod: e.verification ?? null,
			tbr: !!e.tbr,
			tbrOwnerId: e.tbr ? userId(e.tbr.owner) : null,
			tbrDue: e.tbr?.due ?? null
		});
		requirement.set(e.key, created);
		for (const a of e.allocations ?? []) {
			const link = await call(by, 'POST', `/requirements/parts/${partOf(a.part).id}`, { reqNumber: created.reqNumber, notes: named(a.notes) });
			allocation.set(`${e.key}:${a.part}`, link.id);
		}
	},
	/** The next revision of a baselined requirement, as a draft. A `baseline` event makes it the one in force. */
	async revise(by, e) {
		const draft = await call(by, 'POST', `/requirements/${requirementOf(e.requirement).id}/revise`, {});
		requirement.set(
			e.requirement,
			await call(by, 'PATCH', `/requirements/${draft.id}`, {
				...(e.title ? { title: e.title } : {}),
				...(e.statement ? { statement: reflow(e.statement) } : {}),
				...(e.rationale ? { rationale: named(e.rationale) } : {})
			})
		);
	},
	async risk(by, e) {
		risk.set(
			e.key,
			await call(by, 'POST', '/risks', {
				projectId: project.id,
				title: e.title,
				description: named(e.description),
				condition: named(e.condition),
				departure: named(e.departure),
				assetPartId: e.part ? partOf(e.part).id : null,
				assetText: e.asset ?? null,
				consequence: named(e.consequence),
				ownerId: e.owner ? userId(e.owner) : null,
				probability: e.probability,
				impact: e.impact,
				residualProbability: e.residual_probability ?? null,
				residualImpact: e.residual_impact ?? null,
				watchObservable: e.watch?.observable ?? null,
				watchThreshold: e.watch?.threshold ?? null,
				watchContingency: named(e.watch?.contingency)
			})
		);
	},
	/** Ties an issue to a risk as its mitigation or research. */
	async risk_issue(by, e) {
		await call(by, 'POST', `/risks/${riskOf(e.risk).id}/issues`, { issueId: issueOf(e.issue).id, role: e.role ?? 'mitigation' });
	},
	async risk_disposition(by, e) {
		risk.set(
			e.risk,
			await call(by, 'POST', `/risks/${riskOf(e.risk).id}/disposition`, {
				disposition: e.disposition,
				note: named(e.note),
				realizedIssueId: e.realized_as ? issueOf(e.realized_as).id : null
			})
		);
	},
	async risk_accept(by, e) {
		await call(by, 'PATCH', `/risks/${riskOf(e.risk).id}`, { acceptanceRationale: named(e.rationale) });
		risk.set(e.risk, await call(by, 'POST', `/risks/${riskOf(e.risk).id}/accept`, { rationale: named(e.rationale) }));
	},
	/** Creates a dataset from datasets.yaml and enters the rows the file gives it. */
	async dataset(by, e) {
		const d = ((datasetsFile.datasets ?? []) as Rec[]).find((x) => x.key === e.key) ?? fail(`no dataset '${e.key}' in datasets.yaml`);
		const created = await call(by, 'POST', '/datasets', {
			projectId: project.id,
			name: d.name,
			description: reflow(d.description),
			schema: { fields: d.fields },
			procedureId: d.procedure ? procedureOf(d.procedure).id : null
		});
		dataSet.set(e.key, created);
		for (const values of d.rows ?? []) await call(by, 'POST', `/datasets/${created.id}/points`, { values });
	},
	/** Points a person enters by hand. `from` names the work order step that produced one. */
	async points(by, e) {
		const d = dataSet.get(e.dataset) ?? fail(`no dataset '${e.dataset}' yet`);
		for (const row of e.rows) {
			let stepExecutionId: number | null = null;
			if (row.from) {
				const wo = workOrder.get(row.from.order) ?? fail(`no work order '${row.from.order}'`);
				const steps = (await call(by, 'GET', `/executions/${wo.id}`)).steps as Rec[];
				stepExecutionId = (steps.find((x) => x.number === String(row.from.step)) ?? fail(`${wo.woNumber} has no step ${row.from.step}`)).id;
			}
			await call(by, 'POST', `/datasets/${d.id}/points`, { values: row.values, stepExecutionId });
		}
	},
	/** A note on an allocation that stays open. */
	async evidence(by, e) {
		const id = allocation.get(`${e.requirement}:${e.part}`) ?? fail(`'${e.requirement}' is not allocated to '${e.part}'`);
		await call(by, 'PATCH', `/requirements/allocations/${id}`, { notes: named(e.notes) });
	},
	async verify(by, e) {
		const id = allocation.get(`${e.requirement}:${e.part}`) ?? fail(`'${e.requirement}' is not allocated to '${e.part}'`);
		await call(by, 'POST', `/requirements/allocations/${id}/verify`, { notes: named(e.notes) });
	}
};

for (const e of story.events) {
	// `at` states the time. `after`, in minutes, follows the event before it: for an event whose
	// time depends on how long a scripted run took.
	const { at: time, after, by, ...rest } = e;
	const kinds = Object.keys(rest);
	if (kinds.length !== 1 || !handlers[kinds[0]!]) fail(`event ${JSON.stringify(e).slice(0, 80)}: expected one of ${Object.keys(handlers).join(', ')}`);
	at(time);
	if (after) clock += Number(after) * 60_000;
	await handlers[kinds[0]!]!(as(by), rest[kinds[0]!]);
}

// ---------------------------------------------------------------- report

setSystemTime();
const line = (label: string, value: unknown) => console.log(`${label.padEnd(14)}${value}`);
line('data folder', outDir);
line('operations', calls);
for (const [k, p] of part) line(`part`, `${p.internalPn}  ${k}`);
for (const [k, p] of procedure) line('procedure', `${p.templateNumber}  ${k}`);
for (const [k, r] of requirement) line('requirement', `${r.reqNumber}  ${k}`);
for (const [k, o] of order) line('order', `${o.reference}  ${k}  ${o.status}`);
for (const [k, w] of workOrder) line('work order', `${w.woNumber}  ${k}  ${w.status}`);
for (const [k, i] of issue) line('issue', `${i.issueNumber}  ${k}`);
for (const [k, r] of risk) line('risk', `${r.riskNumber}  ${k}`);
db.$client.close();
