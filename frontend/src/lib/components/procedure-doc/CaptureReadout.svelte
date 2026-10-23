<script lang="ts">
	// Captured data on a step that is no longer being worked: the same DATA panel the
	// operator filled in (header count, one field per row, label and spec on the left),
	// with the recorded value where the input was. A dash for absence.
	import { cn } from '#lib/utils.js';
	import { attachmentUrl, gallery } from './viewer.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const fields = $derived(step.data_schema?.fields ?? []);
	const ids = (v: unknown): number[] =>
		Array.isArray(v) ? (v as number[]) : typeof v === 'number' ? [v] : [];
	const present = (v: unknown) =>
		v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
	const required = $derived(fields.filter((f) => f.required));
	const recorded = $derived(required.filter((f) => present(step.data_captured?.[f.name])).length);
</script>

{#if fields.length}
	<section
		class="overflow-hidden rounded-lg border border-border bg-muted/40 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
		aria-label="Captured data"
	>
		<header class="flex h-8 items-center gap-3 border-b border-border px-3 sm:col-span-full">
			<span class="label text-foreground">Data</span>
			{#if required.length}
				<span
					class={cn(
						'font-mono text-xs',
						recorded === required.length ? 'text-ok' : 'text-muted-foreground'
					)}>{recorded}/{required.length} required recorded</span
				>
			{:else}
				<span class="font-mono text-xs text-muted-foreground"
					>{fields.length} {fields.length === 1 ? 'field' : 'fields'}</span
				>
			{/if}
		</header>
		{#each fields as f (f.name)}
			{@const raw = step.data_captured?.[f.name]}
			<div
				class="grid grid-cols-1 items-start gap-x-6 gap-y-1.5 border-t border-border px-3 py-2.5 sm:col-span-full sm:grid-cols-subgrid [header+&]:border-t-0"
			>
				<div class="grid grid-cols-1 gap-0.5 sm:pt-1.5">
					<span class="text-sm font-medium text-foreground">
						{f.label ?? f.name}{#if f.required}<span class="text-error" title="Required">
								*</span
							>{/if}
					</span>
					{#if f.unit || f.min != null || f.max != null}
						<span class="font-mono text-xs text-muted-foreground"
							>{#if f.min != null || f.max != null}{f.min ?? '…'} – {f.max ??
									'…'}{/if}{#if f.unit}{f.min != null || f.max != null
									? ' '
									: ''}{f.unit}{/if}</span
						>
					{/if}
				</div>
				<div class="flex min-h-8 min-w-0 items-center font-mono text-sm tabular-nums">
					{#if f.type === 'photo'}
						{#if ids(raw).length}
							<div class="flex flex-wrap gap-2" use:gallery>
								{#each ids(raw) as pid (pid)}
									<a
										data-pswp
										href={attachmentUrl(pid)}
										data-pswp-caption={f.label ?? f.name}
										class="block aspect-[4/3] h-16 overflow-hidden rounded-md border border-border bg-muted"
										aria-label={`Enlarge ${f.label ?? f.name}`}
									>
										<img
											loading="lazy"
											src={attachmentUrl(pid)}
											alt={f.label ?? f.name}
											class="size-full object-cover"
										/>
									</a>
								{/each}
							</div>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					{:else if !present(raw)}
						<span class="text-muted-foreground">—</span>
					{:else if f.type === 'checkbox'}
						{raw ? 'TRUE' : 'FALSE'}
					{:else}
						<span class="break-words">{raw}</span>
					{/if}
				</div>
			</div>
		{/each}
	</section>
{/if}
