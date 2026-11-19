/**
 * Focus an element that a change is about to draw (a new callout box, a new field's label). It
 * waits for the element for up to half a second. Until the focus lands, keys go to the editor's
 * shortcuts (x deletes, p previews), so a fixed delay that fires too early is not safe.
 */
export function focusWhenDrawn(
	target: string | (() => HTMLElement | null),
	select = false,
	then?: (el: HTMLElement) => void
): void {
	const find = typeof target === 'string' ? () => document.getElementById(target) : target;
	const start = performance.now();
	const attempt = () => {
		const el = find();
		if (el) {
			el.focus();
			if (select && el instanceof HTMLInputElement) el.select();
			then?.(el);
			return;
		}
		if (performance.now() - start < 500) requestAnimationFrame(attempt);
	};
	requestAnimationFrame(attempt);
}
