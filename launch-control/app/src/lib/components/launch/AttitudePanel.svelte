<script lang="ts">
	import { untrack } from 'svelte';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import Section from '#lib/components/opal/Section.svelte';

	let { sim }: { sim: LaunchSim } = $props();

	const SIZE = 200;
	const C = SIZE / 2;
	const MAX = 45;
	const LIMIT = 30;
	const R = 84;
	const GAUGE_W = 120;
	const SERVO_MAX = 5;
	const TRAIL = 20;

	let trail = $state<{ x: number; y: number }[]>([]);

	const r = (deg: number) => (Math.min(Math.abs(deg), MAX) / MAX) * R;
	function at(tilt: number, az: number) {
		const a = (az * Math.PI) / 180;
		return { x: C + r(tilt) * Math.sin(a), y: C - r(tilt) * Math.cos(a) };
	}

	// Track locally: the sim keeps tilt history only as strip-chart frames, without azimuth.
	$effect(() => {
		const p = at(sim.tilt, sim.roll);
		untrack(() => {
			const last = trail[trail.length - 1];
			if (last && last.x === p.x && last.y === p.y) return;
			trail = [...trail, p].slice(-TRAIL);
		});
	});

	const now = $derived(at(sim.tilt, sim.roll));
	const over = $derived(sim.tilt > LIMIT);
	const tvc = $derived(
		sim.flight === 'BOOST'
			? { word: 'ACTIVE', cls: 'font-bold' }
			: sim.phase === 'landed' || sim.phase === 'safed' || sim.flight === 'LANDED'
				? { word: 'SAFE', cls: 'text-quiet' }
				: { word: 'LOCKED', cls: '' }
	);
	const val = $derived(sim.stale ? 'text-quiet' : '');
	const gx = (v: number) =>
		(Math.max(-SERVO_MAX, Math.min(SERVO_MAX, v)) / SERVO_MAX) * (GAUGE_W / 2 - 4) + GAUGE_W / 2;
</script>

{#snippet gauge(v: number, name: string)}
	<svg width={GAUGE_W} height="18" role="img" aria-label="{name} {v.toFixed(1)} °">
		<line x1="4" y1="9" x2={GAUGE_W - 4} y2="9" stroke="var(--border)" stroke-width="1" />
		<line x1="4" y1="3" x2="4" y2="15" stroke="var(--border)" stroke-width="1" />
		<line
			x1={GAUGE_W - 4}
			y1="3"
			x2={GAUGE_W - 4}
			y2="15"
			stroke="var(--border)"
			stroke-width="1"
		/>
		<line x1={GAUGE_W / 2} y1="4" x2={GAUGE_W / 2} y2="14" stroke="var(--quiet)" stroke-width="1" />
		<line
			x1={gx(v)}
			y1="2"
			x2={gx(v)}
			y2="16"
			stroke={sim.stale ? 'var(--quiet)' : 'var(--foreground)'}
			stroke-width="3"
		/>
	</svg>
{/snippet}

<Section title="Attitude and TVC">
	<div class="flex flex-wrap items-start gap-x-4 gap-y-2 p-3">
		<svg
			width={SIZE}
			height={SIZE}
			class="shrink-0"
			role="img"
			aria-label="Tilt {sim.tilt.toFixed(1)} °, limit {LIMIT} °"
		>
			{#each [10, 20] as d (d)}
				<circle cx={C} cy={C} r={r(d)} fill="none" stroke="var(--border)" stroke-dasharray="1 3" />
				<text x={C + 3} y={C - r(d) - 2} font-size="12" class="mono" fill="var(--quiet)">{d}°</text>
			{/each}
			<circle cx={C} cy={C} r={r(LIMIT)} fill="none" stroke="var(--error)" stroke-width="1" />
			<text x={C + 3} y={C - r(LIMIT) - 2} font-size="12" class="mono" fill="var(--error)"
				>{LIMIT}°</text
			>
			<circle cx={C} cy={C} r={R} fill="none" stroke="var(--foreground)" stroke-width="1" />
			<line x1={C} y1={C - R} x2={C} y2={C + R} stroke="var(--border)" stroke-dasharray="1 3" />
			<line x1={C - R} y1={C} x2={C + R} y2={C} stroke="var(--border)" stroke-dasharray="1 3" />
			{#if trail.length > 1}
				<polyline
					points={trail.map((p) => `${p.x},${p.y}`).join(' ')}
					fill="none"
					stroke="var(--quiet)"
					stroke-width="1"
				/>
			{/if}
			<line
				x1={C}
				y1={C}
				x2={now.x}
				y2={now.y}
				stroke={sim.stale ? 'var(--quiet)' : 'var(--foreground)'}
				stroke-width="1.5"
			/>
			<circle cx={now.x} cy={now.y} r="4" fill={sim.stale ? 'var(--quiet)' : 'var(--foreground)'} />
		</svg>
		<table class="min-w-[200px] flex-1 border-collapse text-sm">
			<tbody>
				{#each [['Tilt', sim.tilt.toFixed(1), '°'], ['Roll rate', sim.roll.toFixed(1), '°/s']] as [l, v, u] (l)}
					<tr class="border-b border-dotted border-border">
						<th scope="row" class="label py-1.5 pr-3 text-left font-normal text-quiet">{l}</th>
						<td class="mono py-1.5 text-right whitespace-nowrap tabular-nums {val}"
							>{#if l === 'Tilt' && over}<span class={sim.stale ? '' : 'font-bold text-error'}
									>{v}</span
								>{:else}{v}{/if} <span class="text-quiet">{u}</span></td
						>
					</tr>
				{/each}
				{#each [['Servo X', sim.servoX], ['Servo Y', sim.servoY]] as [l, v] (l)}
					<tr class="border-b border-dotted border-border">
						<th scope="row" class="label py-1.5 pr-3 text-left font-normal text-quiet">{l}</th>
						<td class="py-1.5">
							<div class="flex items-center justify-end gap-2">
								{@render gauge(v as number, l as string)}
								<span class="mono w-16 text-right whitespace-nowrap tabular-nums {val}"
									>{(v as number).toFixed(1)} <span class="text-quiet">°</span></span
								>
							</div>
							<div
								class="mono flex justify-between text-xs text-quiet"
								style="width:{GAUGE_W}px; margin-left:auto; margin-right:4.5rem"
							>
								<span>−{SERVO_MAX}°</span><span>+{SERVO_MAX}°</span>
							</div>
						</td>
					</tr>
				{/each}
				<tr>
					<th scope="row" class="label py-1.5 pr-3 text-left font-normal text-quiet">TVC</th>
					<td class="mono py-1.5 text-right tabular-nums {sim.stale ? 'text-quiet' : tvc.cls}"
						>{tvc.word}</td
					>
				</tr>
			</tbody>
		</table>
	</div>
</Section>
