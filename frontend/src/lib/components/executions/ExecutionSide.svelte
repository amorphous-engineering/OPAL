<script lang="ts">
	// Right column: who is working where, the work order's issues, and the
	// procedure's reference documents. Roster entries jump into the document.
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import { attachmentUrl } from '#lib/components/procedure-doc/index.js';
	import { ticketLabel, ticketTone } from '#lib/components/issues/issues.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, onjump }: { store: ExecutionStore; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	const inst = $derived(doc.instance);
	const size = (n: number) =>
		n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
</script>

<!-- One viewport tall on wide screens and never scrolls as a whole, nor sideways.
     Cards are only as tall as their content and never stretch to fill the column;
     when the column runs out, Issues gives up height first (scrolling inside) while
     Online and Reference documents are capped at 30% each. -->
<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full">
	{#if doc.roster.length}
		<Section
			class="lg:flex lg:max-h-[30%] lg:min-h-0 lg:flex-none lg:flex-col"
			title="Online"
			count={doc.roster.length || undefined}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each doc.roster as r (r.user_id)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-accent/60',
									r.stale && 'opacity-50',
									r.user_id === store.viewerId && 'font-semibold'
								)}
								disabled={r.step_order === null}
								onclick={() => r.step_order !== null && onjump(r.step_order)}
							>
								<span class="truncate">{r.name ?? r.initials}</span>
								{#if r.step_number}<span class="ml-auto text-muted-foreground"
										>OP {r.step_number}</span
									>{/if}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Online" empty="No one online." />
	{/if}

	{#if doc.issues.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-[0_1_auto] lg:flex-col"
			title="Issues"
			count={doc.issues.length || undefined}
		>
			{#snippet actions()}
				<Button size="xs" variant="ghost" href={`/issues/new?execution=${inst.id}`}>+ NEW</Button>
			{/snippet}
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each doc.issues as i (i.id)}
						<li class="border-b border-border px-3 py-1.5 text-xs last:border-b-0">
							<div class="flex items-center gap-2">
								<a class="font-mono font-medium text-info hover:underline" href={`/issues/${i.id}`}
									>{i.issue_number}</a
								>
								{#if i.raised_step_number}
									<span class="font-mono text-muted-foreground" title="Raised at step"
										>@{i.raised_step_number}</span
									>
								{/if}
								<span class="ml-auto"
									><State
										value={i.ticket_state}
										tone={ticketTone(i.ticket_state)}
										label={ticketLabel(i.ticket_state)}
										badge
									/></span
								>
							</div>
							<div class="truncate text-muted-foreground" title={i.title}>{i.title}</div>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Issues" addHref={`/issues/new?execution=${inst.id}`} />
	{/if}

	{#if doc.reference_attachments.length}
		<Section
			class="lg:flex lg:max-h-[30%] lg:min-h-0 lg:flex-none lg:flex-col"
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
</div>
