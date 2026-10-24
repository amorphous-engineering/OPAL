/**
 * Structure of a procedure draft: document order, numbering, and tree edits.
 *
 * A procedure is a two-level tree: top-level OPs (normal ones, then contingency ones), each
 * holding sub-steps. A step stores only its parent, its contingency flag (OPs) and its
 * position among its siblings. Document order, numbers ("1", "1.2", "C1") and levels are
 * derived here, so numbering cannot drift. The functions are pure: they return the rows to
 * change and the caller writes them.
 */

export interface TreeNode {
	id: number;
	parentStepId: number | null;
	isContingency: boolean;
	position: number;
}

export interface Placement {
	id: number;
	parentStepId: number | null;
	isContingency: boolean;
	position: number;
}

export interface Numbered {
	/** 1..n in document order. */
	order: number;
	number: string;
	/** 0 = OP, 1 = sub-step. */
	level: number;
	/** A sub-step reports its OP's flag. */
	isContingency: boolean;
}

const bySibling = (a: TreeNode, b: TreeNode) => a.position - b.position || a.id - b.id;

export function childrenMap<T extends TreeNode>(nodes: T[]): Map<number | null, T[]> {
	const kids = new Map<number | null, T[]>();
	for (const n of nodes) {
		const list = kids.get(n.parentStepId);
		if (list) list.push(n);
		else kids.set(n.parentStepId, [n]);
	}
	for (const list of kids.values()) list.sort(bySibling);
	return kids;
}

/** Normal OPs, then contingency OPs, each followed by its sub-steps. */
export function documentOrder<T extends TreeNode>(nodes: T[]): T[] {
	const kids = childrenMap(nodes);
	const tops = kids.get(null) ?? [];
	const out: T[] = [];
	for (const top of [...tops.filter((t) => !t.isContingency), ...tops.filter((t) => t.isContingency)]) {
		out.push(top, ...(kids.get(top.id) ?? []));
	}
	return out;
}

export function numbering(nodes: TreeNode[]): Map<number, Numbered> {
	const kids = childrenMap(nodes);
	const tops = kids.get(null) ?? [];
	const result = new Map<number, Numbered>();
	const numberOf = new Map<number, string>();
	let normal = 0;
	let cont = 0;
	for (const top of [...tops.filter((t) => !t.isContingency), ...tops.filter((t) => t.isContingency)]) {
		numberOf.set(top.id, top.isContingency ? `C${++cont}` : String(++normal));
	}
	let order = 0;
	for (const top of [...tops.filter((t) => !t.isContingency), ...tops.filter((t) => t.isContingency)]) {
		const number = numberOf.get(top.id)!;
		result.set(top.id, { order: ++order, number, level: 0, isContingency: top.isContingency });
		(kids.get(top.id) ?? []).forEach((sub, i) =>
			result.set(sub.id, {
				order: ++order,
				number: `${number}.${i + 1}`,
				level: 1,
				isContingency: top.isContingency
			})
		);
	}
	return result;
}

/** The rows whose parent, group or position differ from what the layout wants. */
export function changedPlacements(nodes: TreeNode[], wanted: Placement[]): Placement[] {
	const have = new Map(nodes.map((n) => [n.id, n]));
	return wanted.filter((w) => {
		const n = have.get(w.id);
		return !n || n.parentStepId !== w.parentStepId || n.isContingency !== w.isContingency || n.position !== w.position;
	});
}

export function layoutAll(nodes: TreeNode[]): Placement[] {
	return layout(nodes);
}

function layout(nodes: TreeNode[], moving?: { id: number; parentId: number | null; index: number; isContingency: boolean }) {
	const parentOf = new Map(nodes.map((n) => [n.id, n]));
	const rest = nodes.filter((n) => n.id !== moving?.id);
	const kids = childrenMap(rest);
	const tops = kids.get(null) ?? [];
	const groups: { parentId: number | null; isContingency: boolean; members: TreeNode[] }[] = [
		{ parentId: null, isContingency: false, members: tops.filter((t) => !t.isContingency) },
		{ parentId: null, isContingency: true, members: tops.filter((t) => t.isContingency) }
	];
	for (const top of tops) groups.push({ parentId: top.id, isContingency: false, members: kids.get(top.id) ?? [] });
	if (moving) {
		const target = groups.find((g) =>
			moving.parentId === null ? g.parentId === null && g.isContingency === moving.isContingency : g.parentId === moving.parentId
		);
		const self = parentOf.get(moving.id)!;
		const list = target ? target.members : [];
		const at = Math.max(0, Math.min(moving.index, list.length));
		list.splice(at, 0, self);
		if (!target) groups.push({ parentId: moving.parentId, isContingency: false, members: list });
	}
	const out: Placement[] = [];
	for (const g of groups) {
		g.members.forEach((m, position) =>
			out.push({
				id: m.id,
				parentStepId: g.parentId,
				isContingency: g.parentId === null ? g.isContingency : false,
				position
			})
		);
	}
	return out;
}

/** Make every sibling list dense (0..n-1) and clear the flag on sub-steps. */
export function normalize(nodes: TreeNode[]): Placement[] {
	return changedPlacements(nodes, layout(nodes));
}

/**
 * Put `stepId` at `index` among the children of `parentId` (null: the OPs of the group
 * `isContingency`), clamped to the sibling range. Returns the rows that change.
 */
export function place(
	nodes: TreeNode[],
	stepId: number,
	parentId: number | null,
	index: number,
	isContingency = false
): Placement[] {
	const wanted = layout(nodes, { id: stepId, parentId, index, isContingency: parentId === null && isContingency });
	const changed = changedPlacements(nodes, wanted);
	// The placed step is always in the result, also when it did not move: a new step needs it.
	const mine = wanted.find((w) => w.id === stepId);
	return mine && !changed.some((c) => c.id === stepId) ? [...changed, mine] : changed;
}

/** Sibling index of `stepId` among nodes of the same group, ignoring `stepId` itself. */
export function siblingsOf<T extends TreeNode>(nodes: T[], parentId: number | null, isContingency: boolean, excludeId?: number): T[] {
	return (childrenMap(nodes.filter((n) => n.id !== excludeId)).get(parentId) ?? []).filter(
		(s) => parentId !== null || s.isContingency === isContingency
	);
}
