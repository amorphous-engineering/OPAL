<script lang="ts">
	// Structure: vehicle health grouped by source, with data age beside the title.
	import Section from '#lib/components/opal/Section.svelte';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	const BATT_MIN = 7.4;
	const CONT_MAX = 5;

	const age = $derived((sim.packetAge / 1000).toFixed(1));
	// Amber only past the stale threshold plus margin: waiting on a person to decide.
	const severe = $derived(sim.stale && sim.packetAge > 1500);
	const v = $derived(sim.stale ? 'text-quiet' : '');
	const battLow = $derived(sim.fcBatt < BATT_MIN);
</script>

{#snippet group(name: string)}
	<div class="label border-b border-dotted border-border px-3 pt-2 pb-1 text-muted-foreground">
		{name}
	</div>
{/snippet}

{#snippet row(label: string, value: string, last: boolean, cls = '')}
	<div
		class={cn(
			'flex items-baseline gap-3 px-3 py-1',
			!last && 'border-b border-dotted border-border'
		)}
	>
		<dt class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase">
			{label}
		</dt>
		<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v, cls)}>
			{value}
		</dd>
	</div>
{/snippet}

<Section title="Vehicle health">
	{#snippet actions()}
		<span class="mono text-xs text-quiet">LINK {age} s</span>
		{#if sim.stale}
			<span
				class={cn(
					'mono border border-dotted border-foreground px-1.5 text-xs font-bold',
					severe && 'bg-warn-fill text-warn-on'
				)}>STALE {age} s</span
			>
		{/if}
	{/snippet}

	{@render group('Flight computer')}
	<dl class="m-0">
		{@render row('State', sim.fcState, false, 'font-bold')}
		<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
			<dt class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase">
				Battery
			</dt>
			<dd
				class={cn(
					'm-0 font-mono text-[13px] whitespace-nowrap tabular-nums',
					v,
					!sim.stale && battLow && 'text-error'
				)}
			>
				{sim.fcBatt.toFixed(2)} V
				{#if battLow}<span class="font-bold">LOW</span>{/if}
			</dd>
		</div>
		{@render row('Temperature', `${sim.fcTemp.toFixed(1)} °C`, false)}
		{@render row('Log', `${sim.logPct.toFixed(0)} %`, false)}
		{@render row('GPS', `${sim.sats} sats`, true)}
	</dl>

	{@render group('Pyro')}
	<dl class="m-0">
		{#each [{ l: 'Drogue', o: sim.drogueOhm }, { l: 'Main', o: sim.mainOhm }] as ch, i (ch.l)}
			<div
				class={cn(
					'flex items-baseline gap-3 px-3 py-1',
					i === 0 && 'border-b border-dotted border-border'
				)}
			>
				<dt class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase">
					{ch.l}
				</dt>
				<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
					{ch.o.toFixed(1)} Ω
					{#if ch.o < CONT_MAX}
						<span class={cn('font-bold', !sim.stale && 'text-ok')}>CONT</span>
					{:else}
						<span class={cn('font-bold', !sim.stale && 'text-error')}>OPEN</span>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>

	<div class="border-t border-border">
		{@render group('Link')}
		<dl class="m-0">
			{@render row('RSSI', `${sim.rssi} dBm`, false)}
			{@render row('SNR', `${sim.snr.toFixed(1)} dB`, false)}
			{@render row('Packet age', `${age} s`, false, sim.stale ? 'font-bold' : '')}
			{@render row('Packets lost', `${sim.packetsLost}`, false)}
			{@render row('Rate', `${sim.packetRate} Hz`, true)}
		</dl>
	</div>
</Section>
