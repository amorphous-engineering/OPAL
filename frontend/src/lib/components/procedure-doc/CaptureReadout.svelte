<script lang="ts">
	// Captured data as facts: label / value rows, a dash for absence.
	import { attachmentUrl, lightbox } from './lightbox.svelte.js';
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
						class="w-48 py-1 pr-3 text-left align-top font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
					>
						{f.label ?? f.name}{#if f.unit}&nbsp;({f.unit}){/if}
					</th>
					<td class="py-1 font-mono tabular-nums">
						{#if f.type === 'photo'}
							{#each ids(raw) as pid (pid)}
								<button
									type="button"
									class="mr-2 inline-block border border-border"
									onclick={() => lightbox.open(attachmentUrl(pid), f.label ?? f.name)}
									aria-label={`Enlarge ${f.label ?? f.name}`}
								>
									<img
										loading="lazy"
										src={attachmentUrl(pid)}
										alt={f.label ?? f.name}
										class="h-12 w-auto"
									/>
								</button>
							{:else}
								<span class="text-muted-foreground">—</span>
							{/each}
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
