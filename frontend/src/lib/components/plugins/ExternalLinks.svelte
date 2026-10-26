<script lang="ts">
	// Records of other systems that a plugin linked to this record.
	import { onMount } from 'svelte';
	import { Section } from '#lib/components/opal/index.js';
	import { opal } from '#lib/api.js';
	import type { ExternalLink, LinkEntity } from '@opal/shared';

	let { entityType, entityId }: { entityType: LinkEntity; entityId: number } = $props();

	let links = $state<ExternalLink[]>([]);

	onMount(async () => {
		try {
			links = (await opal.plugins.links.list({ entityType, entityId })).items;
		} catch {
			// No links shown: the section does not apply.
		}
	});
</script>

{#if links.length}
	<Section title="External links" count={links.length}>
		<ul class="m-0 list-none p-0">
			{#each links as l (l.id)}
				<li
					class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
				>
					<span class="shrink-0 text-muted-foreground">{l.pluginName}</span>
					<a
						href={l.url}
						target="_blank"
						rel="noopener noreferrer"
						class="min-w-0 truncate text-info hover:underline {l.label ? '' : 'font-mono'}"
						title={l.url}>{l.label ?? l.externalId}</a
					>
				</li>
			{/each}
		</ul>
	</Section>
{/if}
