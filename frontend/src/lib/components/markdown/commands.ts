// Formatting commands for the toolbar and keymap: wrap/unwrap the selection, toggle a line prefix.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

export type Command = (view: EditorView) => boolean;

export function toggleWrap(before: string, after = before): Command {
	return (view) => {
		const { state } = view;
		const tr = state.changeByRange((range) => {
			const doc = state.doc;
			const sel = doc.sliceString(range.from, range.to);
			// The marks sit just outside the selection.
			const pre = doc.sliceString(Math.max(0, range.from - before.length), range.from);
			const post = doc.sliceString(range.to, Math.min(doc.length, range.to + after.length));
			const single = before.length === 1 && before === after;
			const beyond = (pos: number, dir: -1 | 1) =>
				single &&
				doc.sliceString(dir < 0 ? Math.max(0, pos - 1) : pos, dir < 0 ? pos : pos + 1) === before;
			if (
				pre === before &&
				post === after &&
				!beyond(range.from - before.length, -1) &&
				!beyond(range.to + after.length, 1)
			) {
				return {
					changes: [
						{ from: range.from - before.length, to: range.from },
						{ from: range.to, to: range.to + after.length }
					],
					range: EditorSelection.range(range.from - before.length, range.to - before.length)
				};
			}
			// The marks are inside the selection.
			if (
				sel.length >= before.length + after.length &&
				sel.startsWith(before) &&
				sel.endsWith(after) &&
				!(single && (sel.startsWith(before + before) || sel.endsWith(after + after)))
			) {
				return {
					changes: [
						{ from: range.from, to: range.from + before.length },
						{ from: range.to - after.length, to: range.to }
					],
					range: EditorSelection.range(range.from, range.to - before.length - after.length)
				};
			}
			return {
				changes: [
					{ from: range.from, insert: before },
					{ from: range.to, insert: after }
				],
				range: EditorSelection.range(range.from + before.length, range.to + before.length)
			};
		});
		view.dispatch(tr, { scrollIntoView: true, userEvent: 'input.format' });
		return true;
	};
}

const PREFIX = /^(#{1,6} |> |[-*+] |\d+\. )/;

/** Toggle a line prefix on every selected line. `make(i)` returns the prefix for the i-th line. */
export function toggleLinePrefix(
	test: (line: string) => boolean,
	make: (i: number) => string,
	replaceable: RegExp = PREFIX
): Command {
	return (view) => {
		const { state } = view;
		const lines: { from: number; text: string }[] = [];
		const seen = new Set<number>();
		for (const r of state.selection.ranges) {
			const a = state.doc.lineAt(r.from).number;
			const b = state.doc.lineAt(r.to).number;
			for (let n = a; n <= b; n++) {
				if (seen.has(n)) continue;
				seen.add(n);
				const l = state.doc.line(n);
				lines.push({ from: l.from, text: l.text });
			}
		}
		const all = lines.every((l) => test(l.text));
		const changes: ChangeSpec[] = [];
		lines.forEach((l, i) => {
			const m = replaceable.exec(l.text);
			const existing = m ? m[0].length : 0;
			if (all) {
				changes.push({ from: l.from, to: l.from + existing });
			} else {
				changes.push({ from: l.from, to: l.from + existing, insert: make(i) });
			}
		});
		view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
		return true;
	};
}

export const heading = (level: number): Command =>
	toggleLinePrefix(
		(t) => t.startsWith('#'.repeat(level) + ' '),
		() => '#'.repeat(level) + ' '
	);
export const quote: Command = toggleLinePrefix(
	(t) => t.startsWith('> '),
	() => '> '
);
export const bulletList: Command = toggleLinePrefix(
	(t) => /^[-*+] /.test(t),
	() => '- '
);
export const numberedList: Command = toggleLinePrefix(
	(t) => /^\d+\. /.test(t),
	(i) => `${i + 1}. `
);

export const bold = toggleWrap('**');
export const italic = toggleWrap('*');
export const underline = toggleWrap('<u>', '</u>');
export const strike = toggleWrap('~~');
export const code = toggleWrap('`');

export const link: Command = (view) => {
	const { state } = view;
	const r = state.selection.main;
	const text = state.doc.sliceString(r.from, r.to);
	const label = text || 'text';
	const insert = `[${label}](url)`;
	const urlFrom = r.from + label.length + 3;
	view.dispatch({
		changes: { from: r.from, to: r.to, insert },
		selection: EditorSelection.range(urlFrom, urlFrom + 3),
		userEvent: 'input.format',
		scrollIntoView: true
	});
	return true;
};

export type Mark = 'bold' | 'italic' | 'underline' | 'strike';

/** Marks in effect at the cursor, from the syntax tree (and <u> pairs on the line). */
export function activeMarks(state: EditorState): Mark[] {
	const pos = state.selection.main.head;
	const found = new Set<Mark>();
	for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
		if (n.name === 'StrongEmphasis') found.add('bold');
		else if (n.name === 'Emphasis') found.add('italic');
		else if (n.name === 'Strikethrough') found.add('strike');
	}
	const line = state.doc.lineAt(pos);
	for (const m of line.text.matchAll(/<u>(.*?)<\/u>/g)) {
		const a = line.from + (m.index ?? 0);
		if (pos >= a + 3 && pos <= a + m[0].length - 4) found.add('underline');
	}
	return [...found];
}
