/** Drag-and-drop helpers shared by OP headers and step rows in author mode. */
import type { AuthorActions } from '../controller.js';

/** Track the drop side while a row is dragged over another row. */
export function dragOver(au: AuthorActions, e: DragEvent, id: number, into = false) {
	if (au.drag.id === null || au.drag.id === id) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const pos = into ? 'into' : e.clientY < r.top + r.height / 2 ? 'before' : 'after';
	if (au.drag.over?.id !== id || au.drag.over.pos !== pos) au.drag.over = { id, pos };
}

export function dropHere(au: AuthorActions, e: DragEvent, id: number) {
	if (au.drag.id === null) return;
	e.preventDefault();
	e.stopPropagation();
	const over = au.drag.over?.id === id ? au.drag.over : { id, pos: 'after' as const };
	void au.dropOn(over);
}

/** Insertion marker for the row currently under the pointer. */
export function dropMarker(au: AuthorActions | undefined, id: number): string {
	const o = au?.drag.over;
	if (!o || o.id !== id) return '';
	if (o.pos === 'before') return 'shadow-[inset_0_2px_0_var(--primary)]';
	if (o.pos === 'after') return 'shadow-[inset_0_-2px_0_var(--primary)]';
	return 'outline outline-1 -outline-offset-1 outline-primary';
}
