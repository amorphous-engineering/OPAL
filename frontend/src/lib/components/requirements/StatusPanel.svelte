<script lang="ts">
	// Systems-engineering status: coverage and verification roll-ups, plus the
	// red items that need a person (stale, overdue TBR, drafts stuck on lint).
	import { DetailRow, DetailTable, Section } from '#lib/components/opal/index.js';
	import type { Ref, Summary } from './types.js';

	let { summary }: { summary: Summary } = $props();

	const v = $derived(summary.verification);
	const cov = $derived(summary.coverage);
</script>

{#snippet refs(list: Ref[], extra?: (r: Ref) => string)}
	<span class="flex flex-wrap gap-x-3 gap-y-0.5">
		{#each list as r (r.id)}
			<a href={`/requirements/${r.id}`} class="mono text-info hover:underline" title={r.title}
				>{r.reqNumber}{#if extra}<span class="text-muted-foreground"> {extra(r)}</span>{/if}</a
			>
		{/each}
	</span>
{/snippet}

<Section title="STATUS" count={`${summary.total} live`}>
	<div class="grid grid-cols-1 divide-border md:grid-cols-2 md:divide-x">
		<DetailTable>
			<DetailRow label="States" mono>
				{#each ['draft', 'preliminary', 'baselined'] as s (s)}
					<span class="mr-3">{s.toUpperCase()} {summary.byState[s] ?? 0}</span>
				{/each}
			</DetailRow>
			<DetailRow label="Parts coverage" mono>
				<span class={cov.leavesAllocated < cov.leaves ? 'text-warn' : 'text-ok'}
					>{cov.leavesAllocated} / {cov.leaves}</span
				>
				<span class="text-muted-foreground">leaf requirements have parts</span>
			</DetailRow>
			<DetailRow label="Verification set" mono>
				<span class={cov.withVerificationMethod < summary.total ? 'text-warn' : 'text-ok'}
					>{cov.withVerificationMethod} / {summary.total}</span
				>
				<span class="text-muted-foreground">have a method</span>
			</DetailRow>
			<DetailRow label="Verification" mono>
				<span class="mr-3 text-ok">{v.verified} VERIFIED</span>
				<span class="mr-3 text-warn">{v.partial} PARTIAL</span>
				<span class="mr-3">{v.open} OPEN</span>
				<span class="text-muted-foreground">{v.unallocated} NO PARTS</span>
			</DetailRow>
		</DetailTable>
		<DetailTable>
			<DetailRow label="Ready to baseline" mono>
				{#if summary.readyToBaseline}
					<a href="/requirements/queue" class="text-info hover:underline"
						>{summary.readyToBaseline} in queue</a
					>
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
			</DetailRow>
			<DetailRow label="Stale">
				{#if summary.stale.length}{@render refs(summary.stale)}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			</DetailRow>
			<DetailRow label="Overdue TBR">
				{#if summary.overdueTbrs.length}
					<span class="flex flex-wrap gap-x-3 gap-y-0.5 text-error">
						{#each summary.overdueTbrs as t (t.id)}
							<a
								href={`/requirements/${t.id}`}
								class="mono hover:underline"
								title={`${t.title}; owner ${t.owner}`}>{t.reqNumber} +{t.daysOver}d</a
							>
						{/each}
					</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			<DetailRow label="Stuck drafts">
				{#if summary.stuckDrafts.length}{@render refs(summary.stuckDrafts)}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			</DetailRow>
		</DetailTable>
	</div>
</Section>
