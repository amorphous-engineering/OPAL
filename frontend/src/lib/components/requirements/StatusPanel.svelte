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
				>{r.req_number}{#if extra}<span class="text-muted-foreground"> {extra(r)}</span>{/if}</a
			>
		{/each}
	</span>
{/snippet}

<Section title="STATUS" count={`${summary.total} live`}>
	<div class="grid divide-border md:grid-cols-2 md:divide-x">
		<DetailTable>
			<DetailRow label="States" mono>
				{#each ['draft', 'preliminary', 'baselined'] as s (s)}
					<span class="mr-3">{s.toUpperCase()} {summary.by_state[s] ?? 0}</span>
				{/each}
			</DetailRow>
			<DetailRow label="Parts coverage" mono>
				<span class={cov.leaves_allocated < cov.leaves ? 'text-warn' : 'text-ok'}
					>{cov.leaves_allocated} / {cov.leaves}</span
				>
				<span class="text-muted-foreground">leaf requirements have parts</span>
			</DetailRow>
			<DetailRow label="Verification set" mono>
				<span class={cov.with_verification_method < summary.total ? 'text-warn' : 'text-ok'}
					>{cov.with_verification_method} / {summary.total}</span
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
				{#if summary.ready_to_baseline}
					<a href="/requirements/queue" class="text-info hover:underline"
						>{summary.ready_to_baseline} in queue</a
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
				{#if summary.overdue_tbrs.length}
					<span class="flex flex-wrap gap-x-3 gap-y-0.5 text-error">
						{#each summary.overdue_tbrs as t (t.id)}
							<a
								href={`/requirements/${t.id}`}
								class="mono hover:underline"
								title={`${t.title}; owner ${t.owner}`}>{t.req_number} +{t.days_over}d</a
							>
						{/each}
					</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			<DetailRow label="Stuck drafts">
				{#if summary.stuck_drafts.length}{@render refs(summary.stuck_drafts)}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			</DetailRow>
		</DetailTable>
	</div>
</Section>
