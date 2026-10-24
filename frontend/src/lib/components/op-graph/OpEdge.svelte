<script lang="ts">
	import type { OpEdgeData } from './types.js';
	import { BaseEdge, EdgeLabel, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';

	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		markerEnd,
		selected,
		data
	}: EdgeProps = $props();
	const d = $derived(data as OpEdgeData);
	const geometry = $derived(
		getSmoothStepPath({
			sourceX,
			sourceY,
			targetX,
			targetY,
			sourcePosition,
			targetPosition,
			borderRadius: 4
		})
	);
</script>

<BaseEdge
	{id}
	path={geometry[0]}
	{markerEnd}
	interactionWidth={d.editable ? 16 : 0}
	class={['opg-edge', d.redline && 'redline', selected && 'selected']}
/>
{#if d.editable && !d.redline}
	<EdgeLabel x={geometry[1]} y={geometry[2]} selectEdgeOnClick={false}>
		<button
			type="button"
			class="opg-remove"
			aria-label="Remove dependency"
			onclick={(e) => {
				e.stopPropagation();
				d.onremove();
			}}>×</button
		>
	</EdgeLabel>
{/if}
