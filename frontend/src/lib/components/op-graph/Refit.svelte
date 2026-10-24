<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';

	const FLOOR = 1;
	const PAD = 0.1;

	let {
		signal,
		bounds,
		width,
		height
	}: {
		signal: string;
		bounds: { x: number; y: number; w: number; h: number };
		width: number;
		height: number;
	} = $props();
	const { setViewport } = useSvelteFlow();
	let last: string | null = null;

	// Fit to the pane but never below a readable zoom; a graph wider or taller than the pane
	// at that floor anchors to its left/top edge and the user pans.
	function fit() {
		const { x, y, w, h } = bounds;
		const padX = width * PAD;
		const padY = height * PAD;
		const fitZoom = Math.min((width - 2 * padX) / w, (height - 2 * padY) / h);
		const zoom = Math.min(1, Math.max(FLOOR, fitZoom));
		// Horizontal: centre when it fits, else anchor the start of the chain. Vertical: always top.
		const px =
			w * zoom <= width - 2 * padX
				? (width - w * zoom) / 2 - x * zoom
				: Math.min(padX, 16) - x * zoom;
		const py = Math.min(padY, 16) - y * zoom;
		setViewport({ x: px, y: py, zoom }, { duration: 0 });
	}

	// Refit only when the node set changes (or the pane first gets a size), never on edge edits.
	$effect(() => {
		if (!width || !height) return;
		const s = signal;
		if (s === last) return;
		last = s;
		requestAnimationFrame(fit);
	});
</script>
