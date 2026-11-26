<script lang="ts">
	// Structure controls on an OP header or step row, as a quiet bank: grip (drag), move, insert a
	// step after, duplicate, delete. Flat until the row is hovered or holds the focus.
	import { BankKey, KeyBank } from '#lib/components/opal/index.js';
	import { useDoc } from '../controller.js';
	import type { DocOp, DocStep } from '../types.js';

	let { step, op, isOp }: { step: DocStep; op: DocOp; isOp: boolean } = $props();
	const au = useDoc().author!;

	const label = $derived(isOp ? `OP ${step.number}` : `step ${step.number}`);
	const stop = (e: Event) => e.stopPropagation();
</script>

<KeyBank quiet label={`Structure of ${label}`}>
	<BankKey
		class="cursor-grab active:cursor-grabbing"
		draggable="true"
		title="Drag to move"
		aria-label={`Drag ${label}`}
		ondragstart={(e: DragEvent) => {
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
		onclick={stop}>::</BankKey
	>
	<BankKey
		title="Move up (Alt+Up)"
		aria-label={`Move ${label} up`}
		onclick={(e: MouseEvent) => {
			stop(e);
			au.move(step, -1);
		}}>↑</BankKey
	>
	<BankKey
		title="Move down (Alt+Down)"
		aria-label={`Move ${label} down`}
		onclick={(e: MouseEvent) => {
			stop(e);
			au.move(step, 1);
		}}>↓</BankKey
	>
	<BankKey
		title={isOp ? 'Insert a step at the top of this OP (a)' : 'Insert a step after this one (a)'}
		aria-label={`Insert a step after ${label}`}
		onclick={(e: MouseEvent) => {
			stop(e);
			au.addStep(op, step);
		}}>+</BankKey
	>
	<BankKey
		title="Duplicate (d)"
		aria-label={`Duplicate ${label}`}
		onclick={(e: MouseEvent) => {
			stop(e);
			au.duplicate(step);
		}}>DUP</BankKey
	>
	<BankKey
		title="Delete (x)"
		aria-label={`Delete ${label}`}
		onclick={(e: MouseEvent) => {
			stop(e);
			au.remove(step);
		}}>DEL</BankKey
	>
</KeyBank>
