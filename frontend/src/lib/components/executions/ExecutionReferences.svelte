<script lang="ts">
	// The procedure's reference documents, as file links with their size.
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { attachmentUrl } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store }: { store: ExecutionStore } = $props();

	const doc = $derived(store.doc!);
	const size = (n: number) =>
		n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
</script>

{#if doc.reference_attachments.length}
	<Section
		class="lg:flex lg:min-h-0 lg:flex-none lg:flex-col"
		title="Reference documents"
		count={doc.reference_attachments.length || undefined}
	>
		<div class="min-h-0 overflow-x-hidden overflow-y-auto">
			<ul class="m-0 list-none p-0">
				{#each doc.reference_attachments as a (a.id)}
					<li
						class="flex items-center gap-2 border-b border-border px-3 py-1 text-xs last:border-b-0"
					>
						<a
							class="min-w-0 flex-1 truncate font-mono text-info hover:underline"
							href={attachmentUrl(a.id)}
							target="_blank"
							rel="noopener">{a.filename}</a
						>
						<span class="font-mono text-muted-foreground">{size(a.size_bytes)}</span>
					</li>
				{/each}
			</ul>
		</div>
	</Section>
{:else}
	<EmptyLine label="Reference documents" />
{/if}
