// HYBRID and LIVE: decorations over the lezer markdown tree. Syntax marks are hidden
// (replace decorations), styles are mark/line decorations. In HYBRID the lines the
// selection touches keep their marks; in LIVE nothing is revealed.
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		const s = document.createElement('span');
		s.className = 'cm-md-bullet';
		s.textContent = '•';
		return s;
	}
}

class ImageWidget extends WidgetType {
	constructor(
		readonly url: string,
		readonly alt: string,
		readonly below: boolean
	) {
		super();
	}
	eq(o: ImageWidget): boolean {
		return o.url === this.url && o.alt === this.alt && o.below === this.below;
	}
	toDOM(): HTMLElement {
		const wrap = document.createElement('span');
		wrap.className = this.below ? 'cm-md-image cm-md-image-below' : 'cm-md-image';
		if (!/^(\/|https?:)/i.test(this.url)) return wrap;
		const img = document.createElement('img');
		img.src = this.url;
		img.alt = this.alt;
		img.loading = 'lazy';
		wrap.append(img);
		return wrap;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

const INLINE: Record<string, { cls: string; marks: string[] }> = {
	StrongEmphasis: { cls: 'cm-md-strong', marks: ['EmphasisMark'] },
	Emphasis: { cls: 'cm-md-em', marks: ['EmphasisMark'] },
	Strikethrough: { cls: 'cm-md-strike', marks: ['StrikethroughMark'] },
	InlineCode: { cls: 'cm-md-code', marks: ['CodeMark'] },
	Link: { cls: 'cm-md-link', marks: ['LinkMark', 'URL', 'LinkTitle'] }
};

function build(view: EditorView, reveal: boolean): { deco: DecorationSet; atomic: DecorationSet } {
	const { state } = view;
	const doc = state.doc;
	const active: [number, number][] = [];
	if (reveal && view.hasFocus) {
		for (const r of state.selection.ranges) {
			active.push([doc.lineAt(r.from).from, doc.lineAt(r.to).to]);
		}
	}
	const isActive = (from: number, to: number) => active.some(([a, b]) => a <= to && b >= from);

	const out: Range<Decoration>[] = [];
	const rep: Range<Decoration>[] = [];
	const hide = (from: number, to: number, deco: Decoration = hidden) => {
		if (to > from) {
			const r = deco.range(from, to);
			out.push(r);
			rep.push(r);
		}
	};
	const children = (n: SyntaxNode, names: string[]) => {
		const list: SyntaxNode[] = [];
		for (let c = n.firstChild; c; c = c.nextSibling) if (names.includes(c.name)) list.push(c);
		return list;
	};
	const tagStack: number[] = [];

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (ref) => {
				const name = ref.name;
				const inline = INLINE[name];
				if (inline) {
					out.push(mark(inline.cls).range(ref.from, ref.to));
					if (!isActive(ref.from, ref.to)) {
						for (const m of children(ref.node, inline.marks)) hide(m.from, m.to);
					}
					return;
				}
				const hm = /^ATXHeading([1-6])$/.exec(name);
				if (hm) {
					out.push(line(`cm-md-h cm-md-h${hm[1]}`).range(doc.lineAt(ref.from).from));
					return;
				}
				if (name === 'HeaderMark' && ref.node.parent?.name.startsWith('ATXHeading')) {
					if (!isActive(ref.from, ref.to)) {
						const l = doc.lineAt(ref.from);
						const end = doc.sliceString(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
						hide(ref.from, Math.min(end, l.to));
					}
					return;
				}
				if (name === 'Blockquote') {
					const a = doc.lineAt(ref.from).number;
					const b = doc.lineAt(ref.to).number;
					for (let n = a; n <= b; n++) out.push(line('cm-md-quote').range(doc.line(n).from));
					return;
				}
				if (name === 'QuoteMark') {
					if (!isActive(ref.from, ref.to)) {
						const l = doc.lineAt(ref.from);
						const end = doc.sliceString(ref.to, ref.to + 1) === ' ' ? ref.to + 1 : ref.to;
						hide(ref.from, Math.min(end, l.to));
					}
					return;
				}
				if (name === 'ListMark') {
					const bulleted = ref.node.parent?.parent?.name === 'BulletList';
					if (bulleted && !isActive(ref.from, ref.to)) hide(ref.from, ref.to, bullet);
					return;
				}
				if (name === 'FencedCode') {
					const a = doc.lineAt(ref.from).number;
					const b = doc.lineAt(ref.to).number;
					for (let n = a; n <= b; n++) out.push(line('cm-md-fence').range(doc.line(n).from));
					if (!isActive(ref.from, ref.to)) {
						for (const m of children(ref.node, ['CodeMark', 'CodeInfo'])) hide(m.from, m.to);
					}
					return;
				}
				if (
					name === 'URL' &&
					ref.node.parent?.name !== 'Link' &&
					ref.node.parent?.name !== 'Image'
				) {
					out.push(mark('cm-md-link').range(ref.from, ref.to));
					return;
				}
				if (name === 'Image') {
					const text = doc.sliceString(ref.from, ref.to);
					const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)/.exec(text);
					if (!m) return;
					const act = isActive(ref.from, ref.to);
					if (act) {
						const l = doc.lineAt(ref.to);
						out.push(
							Decoration.widget({ widget: new ImageWidget(m[2], m[1], true), side: 1 }).range(l.to)
						);
					} else {
						hide(
							ref.from,
							ref.to,
							Decoration.replace({ widget: new ImageWidget(m[2], m[1], false) })
						);
					}
					return false;
				}
				if (name === 'HTMLTag') {
					const t = doc.sliceString(ref.from, ref.to).toLowerCase();
					if (t === '<u>') {
						tagStack.push(ref.to);
						if (!isActive(ref.from, ref.to)) hide(ref.from, ref.to);
					} else if (t === '</u>') {
						const start = tagStack.pop();
						if (start !== undefined && ref.from > start) {
							out.push(mark('cm-md-underline').range(start, ref.from));
						}
						if (!isActive(ref.from, ref.to)) hide(ref.from, ref.to);
					}
				}
			}
		});
	}
	const set = (list: Range<Decoration>[]) => Decoration.set(list, true);
	return { deco: set(out), atomic: set(rep) };
}

export function livePreview(reveal: boolean) {
	const plugin = ViewPlugin.fromClass(
		class {
			deco: DecorationSet;
			atomic: DecorationSet;
			constructor(view: EditorView) {
				({ deco: this.deco, atomic: this.atomic } = build(view, reveal));
			}
			update(u: ViewUpdate) {
				if (
					u.docChanged ||
					u.selectionSet ||
					u.viewportChanged ||
					u.focusChanged ||
					syntaxTree(u.startState) !== syntaxTree(u.state)
				) {
					({ deco: this.deco, atomic: this.atomic } = build(u.view, reveal));
				}
			}
		},
		{
			decorations: (v) => v.deco,
			provide: (p) =>
				EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none)
		}
	);
	return plugin;
}
