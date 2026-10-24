<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { OpNodeData } from './types.js';

	let { data }: NodeProps = $props();
	const d = $derived(data as OpNodeData);
	const n = $derived(d.node);

	function flagTone(flag: string): string {
		const f = flag.toUpperCase();
		if (f === 'HELD' || f === 'NC') return 'error';
		if (f === 'WAITING' || f === 'BLOCKED') return 'warn';
		return 'muted';
	}
	const tone = $derived.by(() => {
		if (n.kind === 'redline') return 'warn';
		switch (n.status) {
			case 'completed':
				return 'ok';
			case 'in_progress':
				return 'info';
			case 'blocked':
			case 'waiting':
				return 'warn';
			case 'held':
				return 'error';
			case 'skipped':
				return 'muted';
			default:
				return 'default';
		}
	});
</script>

<div
	class="opg-node"
	class:selected={d.selected}
	class:flash={d.flash}
	class:contingency={n.kind === 'contingency'}
	class:redline={n.kind === 'redline'}
	data-tone={tone}
	data-node-id={n.id}
	data-status={n.status ?? ''}
	title={n.title}
>
	<Handle type="target" position={Position.Left} isConnectable={d.editable} class="opg-handle" />
	<div class="opg-row">
		<span class="opg-num">{n.number}</span>
		<span class="opg-title">{n.title}</span>
	</div>
	{#if n.progress || n.flags?.length}
		<div class="opg-meta">
			{#if n.progress}
				<span class="opg-progress">{n.progress.done}/{n.progress.total}</span>
			{/if}
			{#each n.flags ?? [] as flag (flag)}
				<span class="opg-flag" data-tone={flagTone(flag)}>{flag}</span>
			{/each}
		</div>
	{/if}
	<Handle type="source" position={Position.Right} isConnectable={d.editable} class="opg-handle" />
	{#if d.selected && d.actions}
		<div class="opg-actions nodrag nopan">{@render d.actions(n)}</div>
	{/if}
</div>
