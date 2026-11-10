<script lang="ts">
	import type { LaunchSim, Answer } from '#lib/launch/sim.svelte.js';
	import Section from '#lib/components/opal/Section.svelte';
	import ActionLink from '#lib/components/opal/ActionLink.svelte';
	import State from '#lib/components/opal/State.svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	let { sim }: { sim: LaunchSim } = $props();

	const goCount = $derived(sim.poll.filter((p) => p.answer === 'GO').length);
	const outstanding = $derived(sim.poll.filter((p) => p.answer !== 'GO'));

	// Re-pressing the active answer withdraws it.
	function press(id: string, current: Answer, next: Exclude<Answer, null>) {
		sim.answer(id, current === next ? null : next);
	}

	const clock = (at: string) => at.slice(11);
	const key =
		'shadow-key aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:shadow-none font-mono tracking-wide';
</script>

<Section title="Poll" count="{goCount}/{sim.poll.length} GO">
	{#snippet actions()}
		<ActionLink onclick={() => sim.callPoll()}>CALL POLL</ActionLink>
	{/snippet}
	<table class="w-full border-collapse text-sm">
		<tbody>
			{#each sim.poll as p (p.id)}
				<tr class="border-b border-dotted border-border">
					<td class="py-1.5 pr-2 pl-3">
						<div class="flex items-baseline gap-2">
							<span>{p.role}</span>
							{#if p.signs}<span class="label text-quiet">SIGNS</span>{/if}
						</div>
						<div class="mono text-xs text-quiet">
							{p.person}{#if p.at}<span
									>{' · '}{p.signs && p.answer === 'GO' ? 'Signed in OPAL ' : ''}{clock(p.at)}</span
								>{/if}
						</div>
					</td>
					<td class="px-2 py-1.5 text-right">
						{#if p.answer === 'GO'}
							<State value="GO" tone="ok" />
						{:else if p.answer === 'NO-GO'}
							<State value="NO-GO" tone="error" badge />
						{:else}
							<span class="text-quiet">—</span>
						{/if}
					</td>
					<td class="py-1.5 pr-3 pl-2">
						<div class="flex justify-end gap-1.5">
							<Button
								variant="outline"
								size="sm"
								class={key}
								aria-pressed={p.answer === 'GO'}
								onclick={() => press(p.id, p.answer, 'GO')}>GO</Button
							>
							<Button
								variant="outline"
								size="sm"
								class={key}
								aria-pressed={p.answer === 'NO-GO'}
								onclick={() => press(p.id, p.answer, 'NO-GO')}>NO-GO</Button
							>
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="px-3 py-1.5 text-xs">
		{#if sim.pollGo}
			<span class="mono font-medium tracking-wide text-ok">POLL GO</span>
		{:else}
			<span class="text-quiet">Outstanding: {outstanding.map((p) => p.role).join(', ')}</span>
		{/if}
	</p>
</Section>
