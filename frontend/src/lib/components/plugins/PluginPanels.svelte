<script lang="ts">
	// Panels that running plugins add to a record page. The iframe has no allow-same-origin, so
	// the plugin reaches OPAL only with the short-lived token in its URL.
	import { onMount } from 'svelte';
	import { mode } from 'mode-watcher';
	import { Section } from '#lib/components/opal/index.js';
	import { opal } from '#lib/api.js';
	import { PANEL_SLOT_RECORD, type PanelSlot, type PluginPanel } from '@opal/shared';

	let { slot, recordId, number }: { slot: PanelSlot; recordId: number; number: string } = $props();

	const REFRESH_MS = 50 * 60_000;
	let panels = $state<PluginPanel[]>([]);
	let heights = $state<Record<string, number>>({});
	let frames: Record<string, HTMLIFrameElement | undefined> = {};

	async function load() {
		try {
			panels = (await opal.plugins.panels({ slot })).items;
		} catch {
			// A failed refresh keeps the panels on screen; the old token stays valid for its hour.
		}
	}

	function url(p: PluginPanel) {
		const q = new URLSearchParams({
			[PANEL_SLOT_RECORD[slot]]: String(recordId),
			number,
			theme: mode.current === 'dark' ? 'dark' : 'light'
		});
		return `${p.src}${p.src.includes('?') ? '&' : '?'}${q}`;
	}

	function onmessage(e: MessageEvent) {
		const d = e.data as { type?: unknown; height?: unknown } | null;
		if (d?.type !== 'opal-panel-height' || typeof d.height !== 'number' || !isFinite(d.height))
			return;
		for (const [key, f] of Object.entries(frames)) {
			if (f && e.source === f.contentWindow)
				heights[key] = Math.min(1200, Math.max(40, Math.round(d.height)));
		}
	}

	onMount(() => {
		void load();
		const t = setInterval(load, REFRESH_MS);
		window.addEventListener('message', onmessage);
		return () => {
			clearInterval(t);
			window.removeEventListener('message', onmessage);
		};
	});
</script>

{#each panels as p (p.plugin + p.title)}
	{@const key = p.plugin + '\n' + p.title}
	<Section title={p.title}>
		<iframe
			bind:this={frames[key]}
			title={p.title}
			src={url(p)}
			sandbox="allow-scripts allow-forms allow-popups"
			class="block w-full border-0"
			style:height="{heights[key] ?? 120}px"
		></iframe>
	</Section>
{/each}
