<script lang="ts">
	import { DetailRow, DetailTable, PageHeader, Section } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { SEVERITIES, severityOf, type Severity } from '#lib/components/risks/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const m = $derived(data.matrix);

	const cellTone: Record<Severity, string> = {
		low: 'bg-ok-muted',
		medium: 'bg-warn-muted',
		high: 'bg-error-muted'
	};
	const textTone: Record<Severity, string> = {
		low: 'text-ok',
		medium: 'text-warn',
		high: 'text-error'
	};

	const bySeverity = $derived.by(() => {
		const counts: Record<Severity, number> = { low: 0, medium: 0, high: 0 };
		if (m)
			for (let p = 1; p <= 5; p++)
				for (let i = 1; i <= 5; i++) counts[severityOf(p * i)] += m.matrix[p - 1][i - 1];
		return counts;
	});

	const live = (extra: string) => `/risks?active=1&${extra}`;
</script>

<PageHeader title="Risk matrix" crumbs={[{ label: 'Risks', href: '/risks' }, { label: 'Matrix' }]}>
	{#snippet actions()}
		<Button size="sm" variant="outline" href="/risks">REGISTER</Button>
		<Button size="sm" href="/risks/new">+ NEW RISK</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[minmax(0,48rem)_20rem]">
	{#if data.error}
		<p
			role="alert"
			class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
		>
			{data.error}
		</p>
	{:else if m}
		<Section title="Live risks by probability and impact" count={m.total_risks}>
			<div class="overflow-x-auto p-3">
				<table class="w-full border-collapse text-xs">
					<thead>
						<tr>
							<th class="w-32"></th>
							{#each m.labels.impact as label, i (i)}
								<th scope="col" class="label px-1 pb-1.5 text-center">{label}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each [5, 4, 3, 2, 1] as p (p)}
							<tr>
								<th scope="row" class="label py-1 pr-2 text-right whitespace-nowrap"
									>{m.labels.probability[p - 1]}</th
								>
								{#each [1, 2, 3, 4, 5] as i (i)}
									{@const sev = severityOf(p * i)}
									{@const cur = m.matrix[p - 1][i - 1]}
									{@const res = m.residual_matrix[p - 1][i - 1]}
									<td class="p-0.5">
										<div
											class={cn(
												'flex h-16 flex-col items-center justify-center gap-0.5 border border-border',
												cellTone[sev]
											)}
											title={`P${p} × I${i} = ${p * i}`}
										>
											{#if cur}
												<a
													href={live(`probability=${p}&impact=${i}`)}
													class={cn(
														'font-mono text-lg leading-none font-semibold hover:underline',
														textTone[sev]
													)}>{cur}</a
												>
											{:else}
												<span class="font-mono text-xs text-muted-foreground/60">{p * i}</span>
											{/if}
											{#if res}
												<a
													href={live(`residual_probability=${p}&residual_impact=${i}`)}
													class="rounded-sm border border-foreground/50 px-1 font-mono text-xs leading-4 hover:bg-background/60"
													>{res}</a
												>
											{/if}
										</div>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
					{#each SEVERITIES as s (s.value)}
						<span class="flex items-center gap-1.5">
							<span
								class={cn('inline-block size-3 rounded-sm border border-border', cellTone[s.value])}
							></span>
							{s.label}
						</span>
					{/each}
					<span class="flex items-center gap-1.5"
						><span class="font-semibold">N</span> current ·
						<span class="border border-foreground/50 px-1">N</span> residual target</span
					>
				</p>
			</div>
		</Section>

		<Section title="Summary">
			<DetailTable>
				<DetailRow label="Live risks" value={m.total_risks} mono />
				{#each [...SEVERITIES].reverse() as s (s.value)}
					<DetailRow label={s.value}>
						{#if bySeverity[s.value]}
							<a
								class={cn('font-mono hover:underline', textTone[s.value])}
								href={live(`severity=${s.value}`)}>{bySeverity[s.value]}</a
							>
						{:else}
							<span class="font-mono text-muted-foreground">0</span>
						{/if}
					</DetailRow>
				{/each}
			</DetailTable>
		</Section>
	{/if}
</div>
