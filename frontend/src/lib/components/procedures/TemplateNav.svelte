<script lang="ts">
	// Left sidebar: the OP index with step counts, then the template's facts.
	// Each OP entry jumps to it in the document (onjump switches to DOCUMENT first).
	import { cn } from '#lib/utils.js';
	import { DetailRow, DetailTable, EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import type { TemplateData } from './template-data.js';

	/** One OP of whatever the page shows: the draft being edited, or a published version. */
	export interface NavOp {
		key: number;
		number: string;
		title: string;
		steps: number;
	}

	let {
		ops,
		selected,
		counts,
		data,
		unpublished,
		editing,
		onjump
	}: {
		ops: NavOp[];
		selected: number | null;
		counts: { ops: number; steps: number };
		data: TemplateData;
		unpublished: boolean | null;
		/** In edit mode the page carries a DRAFT marker, so the draft row would repeat it. */
		editing: boolean;
		onjump: (key: number) => void;
	} = $props();

	const p = $derived(data.procedure);
	const current = $derived(data.versions.find((v) => v.id === p.currentVersionId));
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
					{#each ops as op (op.key)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/60',
									selected === op.key && 'bg-accent shadow-[inset_2px_0_0_var(--info)]'
								)}
								aria-current={selected === op.key ? 'true' : undefined}
								onclick={() => onjump(op.key)}
							>
								<span class="w-8 shrink-0 font-mono font-medium">{op.number}</span>
								<span class="min-w-0 flex-1 truncate">{op.title || '—'}</span>
								<span class="font-mono text-muted-foreground tabular-nums">{op.steps || '—'}</span>
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
			<DetailRow label="Type" value={p.procedureType.toUpperCase()} mono />
			<DetailRow label="Project">
				<a href={`/projects/${p.projectId}`} class="font-mono text-info hover:underline"
					>{p.projectCode}</a
				>
			</DetailRow>
			<DetailRow label="Status"
				><State
					value={p.status}
					tone={p.status === 'draft' ? 'warn' : p.status === 'obsolete' ? 'error' : 'ok'}
				/></DetailRow
			>
			<DetailRow label="Version">
				{#if current}
					<a href={`/procedures/versions/${current.id}`} class="font-mono text-info hover:underline"
						>v{current.versionNumber}</a
					>
				{:else}—{/if}
			</DetailRow>
			{#if !editing && unpublished === true}
				<DetailRow label="Draft"
					><span class="font-mono text-xs text-warn">DIFFERS FROM v{current?.versionNumber}</span
					></DetailRow
				>
			{/if}
			<DetailRow
				label="Steps"
				value={`${counts.ops + counts.steps} (${counts.ops} OP${counts.ops === 1 ? '' : 'S'})`}
				mono
			/>
		</DetailTable>
	</Section>
</div>
