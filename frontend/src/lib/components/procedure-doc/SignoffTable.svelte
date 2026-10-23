<script lang="ts">
	// The step's sign-off table (execute and readonly modes): one row per slot —
	// label, role, signature, COMPLETE chip or SIGN OFF. The server decides which
	// slot can be signed and why not; this only renders it. A step is complete
	// when every slot is signed.
	import { Button } from '#lib/components/ui/button/index.js';
	import { datetime, iso } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import type { DocOp, DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();

	const rows = $derived(step.signoffs ?? []);
	const sign = $derived(ctl.mode === 'execute' && ctl.active ? ctl.actions.sign : undefined);
	let busy = $state<number | null>(null);

	const initials = (name: string) =>
		name
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => w[0])
			.slice(0, 2)
			.join('')
			.toUpperCase();

	async function run(slot: number) {
		if (!sign || busy !== null) return;
		busy = slot;
		try {
			await sign(step, slot);
		} finally {
			busy = null;
		}
	}
</script>

{#if rows.length}
	<table
		class="w-full border border-border font-mono text-xs"
		aria-label="Sign-offs"
		data-signoffs={step.order}
		data-op={op.order}
	>
		<tbody>
			{#each rows as s (s.slot)}
				{@const signed = s.signed_by !== null}
				<tr class="border-b border-border last:border-b-0" data-slot={s.slot}>
					<td class="w-44 px-3 py-2 font-sans text-sm font-medium">{s.label}</td>
					<td class="w-28 px-3 py-2 text-muted-foreground">{s.role ?? '–'}</td>
					<td class="px-3 py-2">
						{#if s.signed_by}
							<span class="inline-flex items-center gap-2">
								<span
									class="inline-flex h-5 min-w-6 items-center justify-center border border-border px-1 text-xs font-medium"
									aria-hidden="true">{initials(s.signed_by.name)}</span
								>
								<span>
									Signed by <span class="font-sans font-medium">{s.signed_by.name}</span>
									<time datetime={iso(s.signed_at)} title={iso(s.signed_at)}
										>{datetime(s.signed_at)}</time
									>
								</span>
							</span>
						{:else if sign && !s.can_sign && s.blockers.length}
							<GateReason blockers={s.blockers} />
						{:else}
							<span class="text-muted-foreground">–</span>
						{/if}
					</td>
					<td class="w-32 px-3 py-2 text-right">
						{#if signed}
							<span
								class="inline-flex h-5 items-center border border-border px-1.5 text-xs font-medium text-muted-foreground"
								>COMPLETE</span
							>
						{:else if sign}
							<Button
								size="xs"
								variant={s.can_sign ? 'default' : 'outline'}
								disabled={!s.can_sign || busy !== null}
								class={cn(!s.can_sign && 'cursor-not-allowed')}
								onclick={() => run(s.slot)}>SIGN OFF</Button
							>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
