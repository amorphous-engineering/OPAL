<script lang="ts">
	// Captured data as facts: label / value rows, a dash for absence.
	import { attachmentUrl, gallery } from './viewer.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const fields = $derived(step.data_schema?.fields ?? []);
	const ids = (v: unknown): number[] =>
		Array.isArray(v) ? (v as number[]) : typeof v === 'number' ? [v] : [];
</script>

{#if fields.length}
	<table class="w-full border-collapse text-xs">
		<tbody>
			{#each fields as f (f.name)}
				{@const raw = step.data_captured?.[f.name]}
				<tr class="border-b border-border last:border-b-0">
					<th
						scope="row"
						class="w-48 py-1 pr-3 text-left align-top font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
					>
						{f.label ?? f.name}{#if f.unit}&nbsp;({f.unit}){/if}
					</th>
					<td class="py-1 font-mono tabular-nums">
						{#if f.type === 'photo'}
							<span use:gallery>
								{#each ids(raw) as pid (pid)}
									<a
										data-pswp
										href={attachmentUrl(pid)}
										data-pswp-caption={f.label ?? f.name}
										class="mr-2 inline-block border border-border"
										aria-label={`Enlarge ${f.label ?? f.name}`}
									>
										<img
											loading="lazy"
											src={attachmentUrl(pid)}
											alt={f.label ?? f.name}
											class="h-12 w-auto"
										/>
									</a>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/each}
							</span>
						{:else if raw === null || raw === undefined || raw === ''}
							<span class="text-muted-foreground">—</span>
						{:else if f.type === 'checkbox'}
							{raw ? 'YES' : 'NO'}
						{:else}
							{raw}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
