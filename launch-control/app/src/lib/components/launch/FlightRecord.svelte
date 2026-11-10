<script lang="ts">
	// How the flight sits in OPAL: the records it touches and the moments it commits. Prototype
	// facts are static; the verdicts and times come from the sim.
	import {
		ActionLink,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		State
	} from '#lib/components/opal/index.js';
	import { opalHref } from '#lib/opal/link.js';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const FLIGHT = 'FLT-0007';
	const search = (path: string, q: string) => opalHref(`${path}?q=${q}`);

	const inFlight = $derived(sim.phase === 'flight');
	const fired = $derived(sim.firedAt !== null);
	const over = $derived(sim.phase === 'landed' || sim.phase === 'safed');
	const safed = $derived(sim.phase === 'safed');
	const apogee = $derived(Math.round(sim.apogee));
	const deployed = $derived(['DROGUE', 'MAIN', 'LANDED'].includes(sim.flight));

	type Verdict = 'PASS' | 'FAIL' | 'PENDING';
	const requirements = $derived<
		{ id: string; text: string; target: string; measured: string; verdict: Verdict }[]
	>([
		{
			id: 'REQ-0019',
			text: 'Apogee ≥ 600 m AGL',
			target: '≥ 600 m',
			measured: over ? `${apogee} m` : '—',
			verdict: over ? (apogee >= 600 ? 'PASS' : 'FAIL') : 'PENDING'
		},
		{
			id: 'REQ-0022',
			text: 'Drogue deploys within 2 s of apogee',
			target: '≤ 2 s',
			measured: deployed ? 'Deployed' : '—',
			verdict: deployed ? 'PASS' : 'PENDING'
		},
		{
			id: 'REQ-0024',
			text: 'Landing ≤ 500 m from pad',
			target: '≤ 500 m',
			measured: safed ? '412 m' : '—',
			verdict: safed ? 'PASS' : 'PENDING'
		}
	]);

	const risks = [
		{ id: 'RISK-0004', text: 'Motor CATO on pad', severity: 'CRITICAL', state: 'accepted' },
		{ id: 'RISK-0007', text: 'Main fails to deploy', severity: 'HIGH', state: 'open' }
	];

	const logAt = (needle: string) => sim.log.find((e) => e.text.startsWith(needle))?.utc ?? null;
	const moments = $derived([
		{
			label: 'Poll GO',
			at: sim.pollGo
				? sim.poll.map((p) => p.at ?? '').reduce((a, b) => (a > b ? a : b), '') || null
				: null
		},
		{ label: 'Armed', at: sim.armedAt ?? (fired ? logAt('Ignition ARMED') : null) },
		{ label: 'Fired', at: sim.firedAt },
		{ label: 'Landed', at: over ? logAt('Landed') : null },
		{ label: 'Closed', at: safed ? logAt('Vehicle safe') : null }
	]);
</script>

{#snippet id(path: string, q: string)}
	<ActionLink href={search(path, q)} target="_blank" rel="noopener" class="h-auto">{q}</ActionLink>
{/snippet}

<div class="grid gap-3 xl:grid-cols-2">
	<div class="flex flex-col gap-3">
		<Section title="Flight">
			<DetailTable>
				<DetailRow label="Number" value={FLIGHT} mono />
				<DetailRow label="Project">
					{@render id('/projects', 'KST')} <span class="text-muted-foreground">Kestrel</span>
				</DetailRow>
				<DetailRow label="Vehicle">
					{@render id('/parts', 'KST-AV-0003')} Kestrel IV airframe,
					<span class="font-mono">serial 003</span>
				</DetailRow>
				<DetailRow label="Flight computer">
					{@render id('/parts', 'AV-FC-0011')} <span class="font-mono">serial 014</span>
				</DetailRow>
				<DetailRow label="Motor">
					<span class="font-mono">AT-H128W</span>, stock lot
					<span class="font-mono">2207</span>,
					<span class="font-mono tabular-nums">1 EA</span>
					{#if fired}
						<State value="consumed" tone="default" class="ml-2" />
					{:else}
						<State value="allocated" tone="draft" class="ml-2" />
					{/if}
					<span class="text-muted-foreground">consumed at ignition</span>
				</DetailRow>
				<DetailRow label="Procedure">
					{@render id('/procedures', 'PROC-0012')} Launch countdown rev C
				</DetailRow>
				<DetailRow label="Execution">{@render id('/executions', 'WO-0041')}</DetailRow>
				<DetailRow label="Site" value="Lucerne Dry Lake, pad 2" />
				<DetailRow label="Waiver" value="FAA COA window" />
				<DetailRow label="Launch director" value="A. Rivera" />
				<DetailRow label="RSO" value="J. Okafor" />
				<DetailRow label="State">
					<State
						value={sim.phase}
						tone={safed
							? 'ok'
							: sim.phase === 'scrubbed'
								? 'muted'
								: inFlight
									? 'info'
									: sim.phase === 'hold'
										? 'error'
										: sim.phase === 'awaiting-fire'
											? 'warn'
											: 'default'}
					/>
				</DetailRow>
			</DetailTable>
		</Section>

		<Section title="History">
			<DetailTable>
				{#each moments as m (m.label)}
					<DetailRow label={m.label}>
						{#if m.at}<time class="font-mono text-xs tabular-nums" datetime={m.at}
								>{m.at.slice(0, 19).replace('T', ' ')}Z</time
							>{:else}<span class="text-quiet">—</span>{/if}
					</DetailRow>
				{/each}
			</DetailTable>
		</Section>
	</div>

	<div class="flex flex-col gap-3">
		<Section title="Requirements verified by this flight" count={requirements.length}>
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border">
						{#each ['Requirement', 'Target', 'Measured', 'Verdict'] as h (h)}
							<th
								class="px-3 py-1.5 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
								>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each requirements as r (r.id)}
						<tr class="border-b border-dotted border-border last:border-b-0">
							<td class="px-3 py-1.5 align-top">
								{@render id('/requirements', r.id)}
								<span class="block">{r.text}</span>
							</td>
							<td class="px-3 py-1.5 align-top font-mono text-xs whitespace-nowrap tabular-nums"
								>{r.target}</td
							>
							<td
								class="px-3 py-1.5 align-top font-mono text-xs whitespace-nowrap tabular-nums {r.measured ===
								'—'
									? 'text-quiet'
									: ''}">{r.measured}</td
							>
							<td class="px-3 py-1.5 align-top"
								><State
									value={r.verdict}
									tone={r.verdict === 'PASS' ? 'ok' : r.verdict === 'FAIL' ? 'error' : 'draft'}
								/></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</Section>

		<Section title="Risks" count={risks.length}>
			<table class="w-full border-collapse text-sm">
				<tbody>
					{#each risks as r (r.id)}
						<tr class="border-b border-dotted border-border last:border-b-0">
							<td class="px-3 py-1.5 align-top">
								{@render id('/risks', r.id)}
								<span class="block">{r.text}</span>
							</td>
							<td class="px-3 py-1.5 align-top font-mono text-xs whitespace-nowrap">{r.severity}</td
							>
							<td class="px-3 py-1.5 align-top"><State value={r.state} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Section>

		<Section title="Dataset">
			<DetailTable>
				<DetailRow label="Dataset">
					{@render id('/datasets', 'DS-0031')}
					{FLIGHT} telemetry
				</DetailRow>
				<DetailRow label="Samples">
					<span class="font-mono tabular-nums">{sim.samples.length}</span>
				</DetailRow>
				<DetailRow label="Recording">
					{#if inFlight}<span class="font-mono text-xs font-bold tracking-wide">RECORDING</span
						>{:else}<span class="font-mono text-xs tracking-wide">{fired ? 'CLOSED' : 'IDLE'}</span
						>{/if}
				</DetailRow>
			</DetailTable>
		</Section>

		<Section title="Issues raised">
			<EmptyLine label="Issues" empty="No issues.">
				{#snippet action()}
					<ActionLink
						href={opalHref(`/issues/new?execution=WO-0041`)}
						target="_blank"
						rel="noopener">RAISE ISSUE</ActionLink
					>
				{/snippet}
			</EmptyLine>
		</Section>
	</div>
</div>
