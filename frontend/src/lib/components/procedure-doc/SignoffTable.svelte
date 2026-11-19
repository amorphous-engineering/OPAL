<script lang="ts">
	// A declared sign-off (execute and readonly modes): one row per slot — label, role, signature
	// or SIGN OFF. Pressing it is the attestation, with no dialog. The server decides which slot can
	// be signed and why not; this only renders it. A step is complete when every slot is signed.
	// Routine steps have no table: they complete from StepActions. The one person there, who signed
	// an earlier slot, may waive a later one with a reason; the slot then shows that line, not a name.
	import { Avatar } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { datetime, iso } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import WaiverForm from './WaiverForm.svelte';
	import WaiverLine from './WaiverLine.svelte';
	import type { DocOp, DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();

	const rows = $derived(step.signoffs ?? []);
	const sign = $derived(ctl.mode === 'execute' && ctl.active ? ctl.actions.sign : undefined);
	const waive = $derived(ctl.mode === 'execute' && ctl.active ? ctl.actions.waive : undefined);
	let busy = $state<number | null>(null);
	let waiving = $state<number | null>(null);

	async function waiveSlot(slot: number, reason: string) {
		if (!waive) return false;
		const ok = await waive(step, slot, reason);
		if (ok) waiving = null;
		return ok;
	}

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
	<div class="overflow-hidden border border-border">
		<table
			class="w-full font-mono text-xs"
			aria-label="Sign-offs"
			data-signoffs={step.order}
			data-op={op.order}
		>
			<tbody>
				{#each rows as s (s.slot)}
					{@const signed = s.signed_by !== null || s.waived !== null}
					<tr class="border-b border-border last:border-b-0" data-slot={s.slot}>
						<td class="w-44 px-3 py-2 font-sans text-sm font-medium">{s.label}</td>
						<td class="w-28 px-3 py-2 text-muted-foreground">{s.role ?? '–'}</td>
						<td class="px-3 py-2">
							{#if s.signed_by}
								<span class="inline-flex items-center gap-2">
									<Avatar user={s.signed_by} size="sm" />
									<span>
										Signed by <span class="font-sans font-medium">{s.signed_by.name}</span>
										<time datetime={iso(s.signed_at)} title={iso(s.signed_at)}
											>{datetime(s.signed_at)}</time
										>
									</span>
								</span>
							{:else if s.waived}
								<WaiverLine waived={s.waived} />
							{:else if sign && !s.can_sign && s.blockers.length}
								<GateReason blockers={s.blockers} />
							{:else}
								<span class="text-muted-foreground">–</span>
							{/if}
						</td>
						<td class="w-32 px-3 py-2 text-right whitespace-nowrap">
							{#if !signed && waive && s.can_waive && waiving !== s.slot}
								<Button size="sm" variant="outline" onclick={() => (waiving = s.slot)}>WAIVE</Button
								>
							{/if}
							{#if !signed && sign}
								<Button
									size="sm"
									variant={s.can_sign ? 'default' : 'outline'}
									disabled={!s.can_sign || busy !== null}
									class={cn(!s.can_sign && 'cursor-not-allowed')}
									onclick={() => run(s.slot)}>SIGN OFF</Button
								>
							{/if}
						</td>
					</tr>
					{#if waiving === s.slot && s.can_waive && !signed}
						<tr class="border-b border-border last:border-b-0" data-waive-slot={s.slot}>
							<td colspan="4" class="px-3 py-2">
								<WaiverForm
									label={s.label}
									onwaive={(reason) => waiveSlot(s.slot, reason)}
									oncancel={() => (waiving = null)}
								/>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
{/if}
