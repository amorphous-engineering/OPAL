<script lang="ts">
	// The launch console: telemetry and launch control. The checklist is an OPAL execution
	// (WO-0041) the crew works in OPAL. This page shows where they are and gates ARM on it,
	// through the launch-control plugin (lib/opal/link). Everything on this page is simulated in
	// the browser (lib/launch/sim). launch-control/DESIGN.md has the design basis.
	import TabStrip from '#lib/components/opal/TabStrip.svelte';
	import CountdownBar from '#lib/components/launch/CountdownBar.svelte';
	import PollPanel from '#lib/components/launch/PollPanel.svelte';
	import CriteriaPanel from '#lib/components/launch/CriteriaPanel.svelte';
	import ProcedureStrip from '#lib/components/launch/ProcedureStrip.svelte';
	import PadBoxPanel from '#lib/components/launch/PadBoxPanel.svelte';
	import StripCharts from '#lib/components/launch/StripCharts.svelte';
	import FlightTimeline from '#lib/components/launch/FlightTimeline.svelte';
	import AttitudePanel from '#lib/components/launch/AttitudePanel.svelte';
	import RecoveryPanel from '#lib/components/launch/RecoveryPanel.svelte';
	import IgnitionPanel from '#lib/components/launch/IgnitionPanel.svelte';
	import TelemetryPanel from '#lib/components/launch/TelemetryPanel.svelte';
	import AlertList from '#lib/components/launch/AlertList.svelte';
	import EventLog from '#lib/components/launch/EventLog.svelte';
	import FlightRecord from '#lib/components/launch/FlightRecord.svelte';
	import SimBanner from '#lib/components/launch/SimBanner.svelte';
	import { flightSim } from '#lib/launch/sim.svelte.js';

	const sim = flightSim();

	let tab = $state('console');

	// HOLD is one key for anyone, never while typing. Toward safe is always easy.
	function onkeydown(e: KeyboardEvent) {
		const el = e.target as HTMLElement | null;
		if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
			return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === 'h' || e.key === 'H') {
			e.preventDefault();
			sim.hold();
		}
	}
</script>

<svelte:window {onkeydown} />
<svelte:head><title>FLT-0007 Kestrel IV flight 7 · Launch Control</title></svelte:head>

<div class="flex min-h-[calc(100svh-var(--shell-h))] flex-col">
	<SimBanner {sim} />
	<CountdownBar {sim} />
	<div class="flex flex-col gap-3 px-3 pt-3">
		<ProcedureStrip {sim} />
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
		<!-- Fixed positions: launch control left, telemetry centre, vehicle and recovery right. -->
		<div
			class="grid flex-1 gap-3 p-3 lg:grid-cols-[19rem_minmax(0,1fr)] 2xl:grid-cols-[21rem_minmax(0,1fr)_26rem]"
		>
			<div class="flex min-w-0 flex-col gap-3">
				<IgnitionPanel {sim} />
				<PadBoxPanel {sim} />
				<PollPanel {sim} />
				<CriteriaPanel {sim} />
			</div>
			<div class="flex min-w-0 flex-col gap-3">
				<FlightTimeline {sim} />
				<StripCharts {sim} />
				<div class="grid gap-3 xl:grid-cols-2 2xl:hidden">
					<AttitudePanel {sim} />
					<RecoveryPanel {sim} />
				</div>
			</div>
			<div class="flex min-w-0 flex-col gap-3 lg:col-span-2 2xl:col-span-1">
				<AlertList {sim} />
				<div class="hidden flex-col gap-3 2xl:flex">
					<AttitudePanel {sim} />
					<RecoveryPanel {sim} />
				</div>
				<TelemetryPanel {sim} />
			</div>
			<div class="lg:col-span-2 2xl:col-span-3">
				<EventLog {sim} />
			</div>
		</div>
	{:else}
		<div class="p-3"><FlightRecord {sim} /></div>
	{/if}
</div>
