/**
 * Share a fixed-height column between its cards (wide screens only).
 *
 * Every card keeps its content height while the column has room. When the cards do not fit,
 * the tallest ones shrink to one common height, and a shorter card never gives up height to a
 * taller one: the cap is the height that makes everything fit. With three cards no card goes
 * below a third of the column, unless its content is shorter. A capped card scrolls inside.
 *
 * The action stops flexbox from shrinking the cards (any child, also an empty-state line) and
 * sets their max-height itself.
 */
export function fillColumn(node: HTMLElement) {
	const wide = matchMedia('(min-width: 64rem)');
	let frame = 0;

	function layout() {
		frame = 0;
		const cards = [...node.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
		// Clear, then read the content heights, in one frame: nothing paints in between.
		for (const c of cards) {
			c.style.maxHeight = '';
			c.style.flexShrink = wide.matches ? '0' : '';
		}
		if (!wide.matches || !cards.length) return;
		const gap = parseFloat(getComputedStyle(node).rowGap) || 0;
		let room = node.clientHeight - gap * (cards.length - 1);
		let open = cards.length;
		let cap = Infinity;
		for (const h of cards.map((c) => c.getBoundingClientRect().height).sort((a, b) => a - b)) {
			const share = room / open;
			if (h <= share) {
				room -= h;
				open -= 1;
			} else {
				cap = share;
				break;
			}
		}
		if (cap !== Infinity) for (const c of cards) c.style.maxHeight = `${Math.floor(cap)}px`;
	}

	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(layout);
	};
	const resize = new ResizeObserver(schedule);
	resize.observe(node);
	// Content changes (a new comment, an issue raised). Attributes are left out: this action
	// writes styles, and watching them would loop.
	const content = new MutationObserver(schedule);
	content.observe(node, { childList: true, subtree: true, characterData: true });
	wide.addEventListener('change', schedule);
	schedule();

	return {
		destroy() {
			cancelAnimationFrame(frame);
			resize.disconnect();
			content.disconnect();
			wide.removeEventListener('change', schedule);
		}
	};
}
