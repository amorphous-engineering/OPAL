<script lang="ts">
	import Section from '#lib/components/opal/Section.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const utc = (v: string | null) => (v ? `${v.slice(11, 19)} UTC` : '—');
	const firstOpen = $derived(sim.interlocks.findIndex((i) => !i.met));
	const atZero = $derived(sim.phase === 'awaiting-fire');

	const press = (e: Event) => {
		if (sim.canFire) sim.firePress(true);
		else e.preventDefault();
	};
	const release = () => sim.firePress(false);
	const keyDown = (e: KeyboardEvent) => {
		if (e.key !== ' ' && e.key !== 'Enter') return;
		// Suppress the native click so a held key is only the hold, never a second act.
		e.preventDefault();
		if (!e.repeat && sim.canFire) sim.firePress(true);
	};
	const keyUp = (e: KeyboardEvent) => {
		if (e.key === ' ' || e.key === 'Enter') sim.firePress(false);
	};
</script>

<Section title="Ignition">
	{#if sim.firedAt}
		<p class="flex flex-wrap items-baseline gap-x-3 px-3 py-2" aria-live="assertive">
			<span class="font-mono font-bold tabular-nums">FIRED {utc(sim.firedAt)}</span>
			<span class="text-quiet">Motor AT-H128W lot 2207 consumed</span>
		</p>
	{:else if sim.phase === 'scrubbed'}
		<p class="px-3 py-2 text-quiet" aria-live="assertive">SAFE — scrubbed</p>
	{:else}
		<div class="flex flex-col gap-4 p-3 lg:flex-row lg:items-start lg:gap-8">
			<div class="min-w-0 lg:w-80">
				<ul class="text-sm">
					{#each sim.interlocks as il, i (il.label)}
						<li class="flex gap-3 border-b border-dotted border-border py-1 last:border-b-0">
							<span
								class={cn(
									'w-16 shrink-0 font-mono text-xs leading-5 tabular-nums',
									il.met ? 'text-ok' : i === firstOpen ? 'font-bold' : 'text-quiet'
								)}>{il.met ? 'MET' : 'NOT MET'}</span
							>
							<span>{il.label}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-2 text-xs text-quiet">
					Pad key <span
						class={cn(
							'font-mono tabular-nums',
							sim.padKey === 'ARMED' && 'font-bold text-foreground'
						)}>{sim.padKey}</span
					>, physical key mirrored from the pad box
				</p>
			</div>

			<div class="flex flex-wrap items-start gap-4">
				<div class="flex w-44 flex-col gap-1">
					<span class="label">1 ARM</span>
					{#if sim.armed}
						<div
							class="flex h-10 flex-col justify-center bg-warn-fill px-3 font-mono text-warn-on tabular-nums"
							aria-live="assertive"
						>
							<span class="text-sm font-bold">ARMED</span>
							<span class="text-xs">{utc(sim.armedAt)}</span>
						</div>
					{:else}
						<Button class="h-10 text-sm" disabled={!sim.canArm} onclick={() => sim.arm()}
							>ARM</Button
						>
						{#if sim.armBlock}<span class="text-xs text-quiet">{sim.armBlock}</span>{/if}
					{/if}
				</div>

				<div class="flex w-44 flex-col gap-1">
					<span class="label">2 FIRE</span>
					<!-- Red fill is allowed here: FIRE commits the most hazardous act on the console, and the
					     colour matches its consequence. It is lit only while the server-side rules allow it. -->
					<Button
						variant="outline"
						class={cn(
							'relative h-10 overflow-hidden text-sm font-bold',
							sim.canFire &&
								'border-error-fill bg-error-fill text-error-on shadow-key hover:bg-error-fill'
						)}
						aria-disabled={!sim.canFire}
						aria-describedby="fire-hold"
						onpointerdown={press}
						onpointerup={release}
						onpointerleave={release}
						onpointercancel={release}
						onblur={release}
						onkeydown={keyDown}
						onkeyup={keyUp}
					>
						FIRE
						<span
							class="absolute inset-x-0 bottom-0 h-1 bg-foreground"
							style:width="{sim.fireProgress * 100}%"
							aria-hidden="true"
						></span>
					</Button>
					<span
						id="fire-hold"
						class="font-mono text-xs tabular-nums {sim.canFire ? '' : 'text-quiet'}"
					>
						{#if sim.canFire}HOLD 1 s TO FIRE{:else if sim.armed && !atZero}Fires at T−0{:else}Needs
							ARM{/if}
					</span>
				</div>

				{#if sim.armed}
					<div class="flex w-28 flex-col gap-1">
						<span class="label">SAFE</span>
						<Button
							variant="outline"
							class="h-10 text-sm"
							aria-keyshortcuts="none"
							onclick={() => sim.disarm()}>SAFE</Button
						>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</Section>
