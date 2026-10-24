<script lang="ts">
	// Left sidebar: the OP index with step counts, then the template's facts.
	// Each OP entry jumps to it in the document (onjump switches to DOCUMENT first).
	import { cn } from '#lib/utils.js';
	import { DetailRow, DetailTable, EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import type { AuthorStore } from '#lib/authoring/store.svelte.js';
	import type { TemplateData } from './template-data.js';

	let {
		store,
		data,
		unpublished,
		onjump
	}: {
		store: AuthorStore;
		data: TemplateData;
		unpublished: boolean | null;
		onjump: (order: number) => void;
	} = $props();

	const p = $derived(data.procedure);
	const current = $derived(data.versions.find((v) => v.id === p.current_version_id));
	const ops = $derived(store.allOps);
	const selected = $derived(
		store.focusMode
			? store.focusOp
			: store.focusedOrder === null
				? null
				: (store.findStep(store.focusedOrder)?.op.order ?? null)
	);
</script>

<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full">
	{#if ops.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-[0_1_auto] lg:flex-col"
			title="Operations"
			count={ops.length}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each ops as op (op.order)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/60',
									selected === op.order && 'bg-accent shadow-[inset_2px_0_0_var(--info)]'
								)}
								aria-current={selected === op.order ? 'true' : undefined}
								onclick={() => onjump(op.order)}
							>
								<span class="w-8 shrink-0 font-mono font-medium">{op.number}</span>
								<span class="min-w-0 flex-1 truncate">{op.title || '—'}</span>
								<span class="font-mono text-muted-foreground tabular-nums"
									>{op.steps.length || '—'}</span
								>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Operations" />
	{/if}
	<Section class="lg:flex-none" title="Details">
		<DetailTable>
			<DetailRow label="Type" value={p.procedure_type.toUpperCase()} mono />
			<DetailRow label="Status"><State value={p.status} /></DetailRow>
			<DetailRow label="Version">
				{#if current}
					<a href={`/procedures/versions/${current.id}`} class="font-mono text-info hover:underline"
						>v{current.version_number}</a
					>
				{:else}—{/if}
			</DetailRow>
			<DetailRow label="Draft">
				{#if unpublished === null}
					<span class="font-mono text-xs text-muted-foreground">NEVER PUBLISHED</span>
				{:else if unpublished}
					<span class="font-mono text-xs text-warn">CHANGED</span>
				{:else}
					<span class="font-mono text-xs text-muted-foreground">MATCHES</span>
				{/if}
			</DetailRow>
			<DetailRow
				label="Steps"
				value={`${store.counts.ops + store.counts.steps} (${store.counts.ops} OP${store.counts.ops === 1 ? '' : 'S'})`}
				mono
			/>
		</DetailTable>
	</Section>
</div>
