<script lang="ts">
	import type { LabelSize } from './sizes.js';
	import type { LabelSpec } from './types.js';

	let { spec, size }: { spec: LabelSpec; size: LabelSize } = $props();
	const compact = $derived(size.height < 1.2);
</script>

<!-- A physical label: fixed paper colours, independent of the app theme. -->
<div class="label-face" style="--w: {size.width}in; --h: {size.height}in" data-compact={compact}>
	<img class="qr" src={spec.qr} alt="QR code for {spec.primary}" />
	<div class="text">
		<div class="primary">{spec.primary}</div>
		{#if spec.secondary}<div class="secondary">{spec.secondary}</div>{/if}
		<div class="name">{spec.name}</div>
		{#if !compact && spec.facts?.length}
			<div class="facts">
				{#each spec.facts as f (f)}<span>{f}</span>{/each}
			</div>
		{/if}
		{#if !compact && (spec.footer || spec.state)}
			<div class="footer">
				<span>{spec.footer ?? ''}</span>
				{#if spec.state}<span class="state">{spec.state}</span>{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.label-face {
		box-sizing: border-box;
		width: var(--w);
		height: var(--h);
		padding: calc(var(--h) * 0.06);
		display: flex;
		align-items: center;
		gap: calc(var(--h) * 0.08);
		background: #fff;
		color: #000;
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
		overflow: hidden;
		break-inside: avoid;
	}
	.qr {
		flex: none;
		height: min(calc(var(--h) * 0.84), calc(var(--w) * 0.42));
		width: min(calc(var(--h) * 0.84), calc(var(--w) * 0.42));
		object-fit: contain;
		image-rendering: pixelated;
		background: #fff;
	}
	.text {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: calc(var(--h) * 0.025);
		align-self: stretch;
		justify-content: center;
	}
	.text > * {
		flex: none;
	}
	.primary {
		font-size: min(calc(var(--h) * 0.17), calc(var(--w) * 0.062));
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1.05;
		overflow-wrap: anywhere;
	}
	.secondary {
		font-size: calc(var(--h) * 0.09);
		font-weight: 600;
		line-height: 1.1;
	}
	.name {
		font-family: 'Inter Variable', system-ui, sans-serif;
		font-size: calc(var(--h) * 0.095);
		line-height: 1.15;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0 calc(var(--h) * 0.06);
		font-size: calc(var(--h) * 0.075);
		line-height: 1.25;
	}
	.footer {
		display: flex;
		justify-content: space-between;
		gap: calc(var(--h) * 0.04);
		border-top: 1px solid #000;
		padding-top: calc(var(--h) * 0.02);
		font-size: calc(var(--h) * 0.065);
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.state {
		font-weight: 700;
	}
	[data-compact='true'] .primary {
		font-size: min(calc(var(--h) * 0.2), calc(var(--w) * 0.062));
	}
	[data-compact='true'] .name {
		font-size: calc(var(--h) * 0.11);
	}
</style>
