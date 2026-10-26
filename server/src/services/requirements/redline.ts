/**
 * Word-level redlines between requirement revisions. A diff over word tokens, with whitespace
 * kept in the stream so reflowed text does not light up as a change wall.
 */
import type { RequirementSegment as Segment } from '@opal/shared';

const tokens = (s: string) => s.match(/\S+|\s+/g) ?? [];

type Block = [number, number, number];

/** Longest common run of tokens in a[alo,ahi) x b[blo,bhi); the earliest wins a tie. */
function longestMatch(a: string[], b: string[], alo: number, ahi: number, blo: number, bhi: number): Block {
	let bestI = alo;
	let bestJ = blo;
	let bestSize = 0;
	let prev = new Array<number>(bhi - blo + 1).fill(0);
	for (let i = alo; i < ahi; i++) {
		const cur = new Array<number>(bhi - blo + 1).fill(0);
		for (let j = blo; j < bhi; j++) {
			if (a[i] === b[j]) {
				const k = prev[j - blo]! + 1;
				cur[j - blo + 1] = k;
				if (k > bestSize) {
					bestI = i - k + 1;
					bestJ = j - k + 1;
					bestSize = k;
				}
			}
		}
		prev = cur;
	}
	return [bestI, bestJ, bestSize];
}

function matchingBlocks(a: string[], b: string[]): Block[] {
	const out: Block[] = [];
	const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop()!;
		const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi);
		if (!k) continue;
		out.push([i, j, k]);
		if (alo < i && blo < j) queue.push([alo, i, blo, j]);
		if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
	}
	return out.sort((x, y) => x[0] - y[0]);
}

/** Token-pair budget for the diff; stored text can be longer than the input caps allow. */
export const REDLINE_BUDGET = 4_000_000;

/** Ordered segments: equal, delete or insert text. */
export function redlineSegments(oldText: string, newText: string): Segment[] {
	if (oldText === newText) return oldText ? [{ op: 'equal', text: oldText }] : [];
	const a = tokens(oldText);
	const b = tokens(newText);
	if (a.length * b.length > REDLINE_BUDGET) {
		const whole: Segment[] = [];
		if (oldText) whole.push({ op: 'delete', text: oldText });
		if (newText) whole.push({ op: 'insert', text: newText });
		return whole;
	}
	const segments: Segment[] = [];
	const push = (op: Segment['op'], text: string) => {
		if (!text) return;
		const last = segments[segments.length - 1];
		if (last && last.op === op) last.text += text;
		else segments.push({ op, text });
	};
	let i = 0;
	let j = 0;
	for (const [ai, bj, size] of [...matchingBlocks(a, b), [a.length, b.length, 0] as Block]) {
		if (i < ai || j < bj) {
			push('delete', a.slice(i, ai).join(''));
			push('insert', b.slice(j, bj).join(''));
		}
		push('equal', a.slice(ai, ai + size).join(''));
		i = ai + size;
		j = bj + size;
	}
	return segments;
}
