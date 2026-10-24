/** Differences between two snapshots: per step (matched by number), per part list. */
import type { PartDiff, ProcedureSnapshot, SnapshotStep, StepDiff } from '@opal/shared';
import { relabel } from './signoffs.ts';

const STEP_FIELDS = [
	'title',
	'instructions',
	'isContingency',
	'estimatedDurationMinutes',
	'workcenterId',
	'callouts',
	'dataSchema',
	'signoffs',
	'strictSequence',
	'dependsOn',
	'kit',
	'images'
] as const;

/** Compare values by content: JSON text, with object keys in a fixed order. */
function same(a: unknown, b: unknown): boolean {
	const canon = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canon)
			: v && typeof v === 'object'
				? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)]))
				: v;
	return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** A step as it is compared: references by step number, labels by position. */
function comparable(s: SnapshotStep, numberOf: Map<number, string>) {
	return {
		...s,
		signoffs: relabel(s.signoffs),
		dependsOn: s.dependsOn.map((d) => numberOf.get(d) ?? `#${d}`).sort(),
		images: s.images.map((i) => ({ sha256: i.sha256, caption: i.caption })),
		kit: [...s.kit].sort((x, y) => x.partId - y.partId)
	};
}

/** 1, 1.1, 1.2, 2, C1, C1.1 */
function stepSortKey(n: string): [number, number[]] {
	return [n.startsWith('C') ? 1 : 0, n.replace(/^C/, '').split('.').map((p) => Number.parseInt(p, 10) || 0)];
}

export function diffSteps(a: ProcedureSnapshot, b: ProcedureSnapshot) {
	const numA = new Map(a.steps.map((s) => [s.id, s.number]));
	const numB = new Map(b.steps.map((s) => [s.id, s.number]));
	const mapA = new Map(a.steps.map((s) => [s.number, comparable(s, numA)]));
	const mapB = new Map(b.steps.map((s) => [s.number, comparable(s, numB)]));
	const numbers = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => {
		const [cx, nx] = stepSortKey(x);
		const [cy, ny] = stepSortKey(y);
		if (cx !== cy) return cx - cy;
		for (let i = 0; i < Math.max(nx.length, ny.length); i++) {
			const d = (nx[i] ?? -1) - (ny[i] ?? -1);
			if (d) return d;
		}
		return 0;
	});
	const out: StepDiff[] = [];
	for (const number of numbers) {
		const sa = mapA.get(number);
		const sb = mapB.get(number);
		if (sa && !sb) {
			out.push({ status: 'removed', number, titleA: sa.title, titleB: null, changedFields: [], changes: {} });
		} else if (sb && !sa) {
			out.push({ status: 'added', number, titleA: null, titleB: sb.title, changedFields: [], changes: {} });
		} else if (sa && sb) {
			const changed = STEP_FIELDS.filter((f) => !same(sa[f], sb[f]));
			out.push({
				status: changed.length ? 'modified' : 'unchanged',
				number,
				titleA: sa.title,
				titleB: sb.title,
				changedFields: changed,
				changes: Object.fromEntries(changed.map((f) => [f, { a: sa[f], b: sb[f] }]))
			});
		}
	}
	return out;
}

/** Procedure-level fields that differ (name, description, type). */
export function diffProcedure(a: ProcedureSnapshot, b: ProcedureSnapshot) {
	return (['name', 'description', 'procedureType'] as const)
		.filter((k) => a.procedure[k] !== b.procedure[k])
		.map((k) => ({ field: k, a: a.procedure[k] ?? null, b: b.procedure[k] ?? null }));
}

/** One row per part that was added, removed or changed in quantity. Unchanged parts are left out. */
export function diffPartLists(
	a: { partId: number; quantity: string }[],
	b: { partId: number; quantity: string }[]
): Omit<PartDiff, 'internalPn' | 'name'>[] {
	const ma = new Map(a.map((x) => [x.partId, x.quantity]));
	const mb = new Map(b.map((x) => [x.partId, x.quantity]));
	const rows: Omit<PartDiff, 'internalPn' | 'name'>[] = [];
	for (const partId of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y)) {
		const qa = ma.get(partId);
		const qb = mb.get(partId);
		if (qa === undefined) rows.push({ partId, status: 'added', quantityA: null, quantityB: qb! });
		else if (qb === undefined) rows.push({ partId, status: 'removed', quantityA: qa, quantityB: null });
		else if (Number(qa) !== Number(qb)) rows.push({ partId, status: 'modified', quantityA: qa, quantityB: qb });
	}
	return rows;
}
