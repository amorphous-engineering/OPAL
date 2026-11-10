<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import ActionLink from '#lib/components/opal/ActionLink.svelte';
	import MoreMenu from '#lib/components/opal/MoreMenu.svelte';
	import { tTime, type LaunchSim, type Phase } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const WORD: Record<Phase, { text: string; cls: string }> = {
		count: { text: 'COUNTING', cls: 'font-bold text-foreground' },
		hold: { text: 'HOLD', cls: 'border border-error-fill bg-error-fill px-1.5 text-error-on' },
		'awaiting-fire': {
			text: 'AWAITING FIRE',
			cls: 'border border-warn-fill bg-warn-fill px-1.5 text-warn-on'
		},
		flight: { text: 'IN FLIGHT', cls: 'font-bold text-foreground' },
		landed: { text: 'LANDED', cls: 'text-ok' },
		safed: { text: 'SAFE', cls: 'text-ok' },
		scrubbed: { text: 'SCRUBBED', cls: 'text-quiet' }
	};

	let scrubbing = $state(false);
	let reason = $state('');

	const canScrub = $derived(!['flight', 'landed', 'safed', 'scrubbed'].includes(sim.phase));
	const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19) + 'Z';
	const hhmm = (d: Date) => d.toISOString().slice(11, 16) + 'Z';

	// Announce a new unacknowledged alert once; the visible fill alone is not a text channel.
	const announce = $derived(
		sim.unackedWarning ? 'Master warning' : sim.unackedCaution ? 'Master caution' : ''
	);

	function confirmScrub() {
		if (!reason.trim()) return;
		sim.scrub(reason);
		scrubbing = false;
		reason = '';
	}

	function cancelScrub() {
		scrubbing = false;
		reason = '';
	}

	const annun = 'h-10 min-w-32 px-3 font-mono text-xs font-semibold tracking-wider border';
</script>

<div class="sticky top-11 z-20 border-b border-border bg-background">
	{#if sim.phase === 'scrubbed' && sim.scrubReason}
		<div class="border-b border-dotted border-border px-4 py-1.5 font-mono text-xs">
			<span class="font-semibold">SCRUBBED</span>
			<span class="text-quiet">·</span>
			{sim.scrubReason}
		</div>
	{/if}
	<div class="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
		<div class="flex min-w-0 flex-wrap items-baseline gap-x-3">
			<span class="font-mono text-lg font-semibold whitespace-nowrap text-info">FLT-0007</span>
			<h1
				class="text-lg font-semibold tracking-tight {sim.phase === 'scrubbed'
					? 'text-quiet line-through'
					: ''}"
			>
				Kestrel IV flight 7
			</h1>
			<span
				class="font-mono text-xs font-semibold tracking-wider whitespace-nowrap {WORD[sim.phase]
					.cls}">{WORD[sim.phase].text}</span
			>
		</div>

		<div class="mx-auto flex flex-col items-center">
			<div
				class="font-mono text-4xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums sm:text-5xl"
				aria-label="Count clock"
			>
				{tTime(sim.clockMs)}
			</div>
			<div
				class="mt-1 flex flex-wrap justify-center gap-x-3 font-mono text-xs text-muted-foreground tabular-nums"
			>
				{#if sim.phase === 'hold'}
					<span class="text-foreground"
						>{sim.holdReason ?? 'Hold'}{sim.holdBy ? ` · ${sim.holdBy}` : ''}</span
					>
					{#if sim.recycle}<span>Recycle to T−00:01:00 on resume</span>{/if}
				{/if}
				<span>{hhmmss(sim.now)}</span>
				<span>Window closes {hhmm(sim.windowCloses)}</span>
			</div>
		</div>

		<div class="ml-auto flex flex-wrap items-center gap-2">
			<div role="status" aria-live="polite" class="sr-only">{announce}</div>
			<button
				type="button"
				onclick={() => sim.ack('warning')}
				aria-label="Master warning{sim.unackedWarning ? ', unacknowledged' : ''}"
				class="{annun} {sim.unackedWarning
					? 'border-error-fill bg-error-fill text-error-on'
					: 'border-dotted border-quiet text-quiet'}"
			>
				MASTER WARNING
			</button>
			<button
				type="button"
				onclick={() => sim.ack('caution')}
				aria-label="Master caution{sim.unackedCaution ? ', unacknowledged' : ''}"
				class="{annun} {sim.unackedCaution
					? 'border-warn-fill bg-warn-fill text-warn-on'
					: 'border-dotted border-quiet text-quiet'}"
			>
				MASTER CAUTION
			</button>

			{#if sim.phase === 'hold'}
				<div class="flex items-center gap-2">
					<Button class="h-10 px-4" disabled={!sim.canResume} onclick={() => sim.resume()}
						>RESUME COUNT</Button
					>
					{#if !sim.canResume && sim.resumeBlock}
						<span class="max-w-56 font-mono text-xs text-muted-foreground">{sim.resumeBlock}</span>
					{/if}
				</div>
			{:else if sim.phase === 'count' || sim.phase === 'awaiting-fire'}
				<Button
					variant="outline"
					class="h-10 gap-2 px-4 text-sm font-semibold"
					onclick={() => sim.hold()}>HOLD <Kbd>H</Kbd></Button
				>
			{:else if sim.phase === 'landed'}
				<Button class="h-10 px-4" onclick={() => sim.safeVehicle()}>SAFE VEHICLE</Button>
			{/if}

			<MoreMenu
				items={[
					{ label: 'SCRUB', strike: true, when: canScrub, onselect: () => (scrubbing = true) }
				]}
			/>
			<ActionLink
				aria-pressed={sim.muted}
				onclick={() => (sim.muted = !sim.muted)}
				class="text-quiet">{sim.muted ? 'ALERT TONE: MUTED' : 'ALERT TONE: ON'}</ActionLink
			>
		</div>
	</div>

	{#if scrubbing && canScrub}
		<form
			class="flex flex-wrap items-center gap-2 border-t border-dotted border-border px-4 py-2"
			onsubmit={(e) => {
				e.preventDefault();
				confirmScrub();
			}}
		>
			<label class="label" for="scrub-reason">Scrub reason</label>
			<!-- svelte-ignore a11y_autofocus -->
			<Input
				id="scrub-reason"
				bind:value={reason}
				required
				autofocus
				class="max-w-lg min-w-48 flex-1 border-dashed"
			/>
			<Button
				type="submit"
				disabled={!reason.trim()}
				class="border-error-fill bg-error-fill text-error-on shadow-key hover:bg-error-fill"
				>SCRUB FLIGHT</Button
			>
			<Button type="button" variant="ghost" onclick={cancelScrub}>Cancel</Button>
		</form>
	{/if}
</div>
