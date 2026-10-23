<script lang="ts">
	// Structure controls on an OP header or step row: grip (drag), move, add a
	// step after, duplicate, delete. Always visible; stronger on hover/focus.
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { DocOp, DocStep } from '../types.js';

	let { step, op, isOp }: { step: DocStep; op: DocOp; isOp: boolean } = $props();
	const au = useDoc().author!;

	const btn = 'min-w-6 border-0 px-1 font-mono text-xs text-muted-foreground disabled:opacity-40';
	const label = $derived(isOp ? `OP ${step.number}` : `step ${step.number}`);
</script>

<span
	class="flex shrink-0 items-center opacity-70 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
	role="group"
	aria-label={`Structure of ${label}`}
>
	<Button
		variant="ghost"
		size="sm"
		class={cn(btn, 'cursor-grab active:cursor-grabbing')}
		draggable="true"
		title="Drag to move"
		aria-label={`Drag ${label}`}
		ondragstart={(e) => {
			e.stopPropagation();
			au.drag.id = step.order;
			e.dataTransfer?.setData('text/plain', String(step.order));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
			const row = (e.currentTarget as HTMLElement).closest('[data-drop-row]');
			if (row && e.dataTransfer) e.dataTransfer.setDragImage(row, 12, 12);
		}}
		ondragend={() => {
			au.drag.id = null;
			au.drag.over = null;
		}}
		onclick={(e) => e.stopPropagation()}>::</Button
	>
	<Button
		variant="ghost"
		size="sm"
		class={btn}
		title="Move up (Alt+Up)"
		aria-label={`Move ${label} up`}
		onclick={(e) => {
			e.stopPropagation();
			au.move(step, -1);
		}}>↑</Button
	>
	<Button
		variant="ghost"
		size="sm"
		class={btn}
		title="Move down (Alt+Down)"
		aria-label={`Move ${label} down`}
		onclick={(e) => {
			e.stopPropagation();
			au.move(step, 1);
		}}>↓</Button
	>
	<Button
		variant="ghost"
		size="sm"
		class={btn}
		title={isOp ? 'Add a step in this OP (a)' : 'Add a step after this one (a)'}
		aria-label={`Add a step after ${label}`}
		onclick={(e) => {
			e.stopPropagation();
			au.addStep(op, step);
		}}>+</Button
	>
	<Button
		variant="ghost"
		size="sm"
		class={btn}
		title="Duplicate (d)"
		aria-label={`Duplicate ${label}`}
		onclick={(e) => {
			e.stopPropagation();
			au.duplicate(step);
		}}>DUP</Button
	>
	<Button
		variant="ghost"
		size="sm"
		class={cn(btn, 'hover:text-error')}
		title="Delete (x)"
		aria-label={`Delete ${label}`}
		onclick={(e) => {
			e.stopPropagation();
			au.remove(step);
		}}>DEL</Button
	>
</span>
