<script lang="ts">
	// Launch console (prototype). The flight is a record: the countdown is an execution of a
	// released procedure, the vehicle and motor are serials and stock, telemetry goes to a dataset.
	// Everything on this page is simulated in the browser (lib/launch/sim). LAUNCH.md has the
	// design basis and the standards it follows.
	import { onDestroy } from 'svelte';
	import TabStrip from '#lib/components/opal/TabStrip.svelte';
	import CountdownBar from '#lib/components/launch/CountdownBar.svelte';
	import PollPanel from '#lib/components/launch/PollPanel.svelte';
	import CriteriaPanel from '#lib/components/launch/CriteriaPanel.svelte';
	import CountSteps from '#lib/components/launch/CountSteps.svelte';
	import IgnitionPanel from '#lib/components/launch/IgnitionPanel.svelte';
	import TelemetryPanel from '#lib/components/launch/TelemetryPanel.svelte';
	import AlertList from '#lib/components/launch/AlertList.svelte';
	import EventLog from '#lib/components/launch/EventLog.svelte';
	import FlightRecord from '#lib/components/launch/FlightRecord.svelte';
	import SimBanner from '#lib/components/launch/SimBanner.svelte';
	import { LaunchSim } from '#lib/launch/sim.svelte.js';

	const sim = new LaunchSim();
	sim.start();
	onDestroy(() => sim.stop());

	let tab = $state('console');

	// HOLD is one key for anyone, never while typing. Toward safe is always easy.
	function onkeydown(e: KeyboardEvent) {
		const el = e.target as HTMLElement | null;
		if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === 'h' || e.key === 'H') {
			e.preventDefault();
			sim.hold();
		}
	}
</script>

<svelte:window {onkeydown} />
<svelte:head><title>FLT-0007 Kestrel IV flight 7 · OPAL</title></svelte:head>

<div class="flex min-h-[calc(100svh-var(--shell-h))] flex-col">
	<SimBanner {sim} />
	<CountdownBar {sim} />
	<div class="px-3 pt-3">
		<TabStrip
			tabs={[
				{ id: 'console', label: 'Console' },
				{ id: 'record', label: 'Record' }
			]}
			value={tab}
			onchange={(id) => (tab = id)}
		/>
	</div>
	{#if tab === 'console'}
		<div
			class="grid flex-1 gap-3 p-3 lg:grid-cols-[17rem_minmax(0,1fr)_20rem] xl:grid-cols-[19rem_minmax(0,1fr)_23rem]"
		>
			<div class="flex min-w-0 flex-col gap-3">
				<PollPanel {sim} />
				<CriteriaPanel {sim} />
			</div>
			<div class="flex min-w-0 flex-col gap-3">
				<IgnitionPanel {sim} />
				<CountSteps {sim} />
			</div>
			<div class="flex min-w-0 flex-col gap-3">
				<AlertList {sim} />
				<TelemetryPanel {sim} />
			</div>
			<div class="lg:col-span-3">
				<EventLog {sim} />
			</div>
		</div>
	{:else}
		<div class="p-3"><FlightRecord {sim} /></div>
	{/if}
</div>
