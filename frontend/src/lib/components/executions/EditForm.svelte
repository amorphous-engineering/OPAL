<script lang="ts">
	// Work order facts that can change after the cut: number, schedule, priority.
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { InstanceFacts } from '#lib/execution/types.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let {
		store,
		facts,
		onclose
	}: { store: ExecutionStore; facts: InstanceFacts; onclose: () => void } = $props();

	// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm".
	const local = (iso: string | null) => {
		if (!iso) return '';
		const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	};

	// The form edits a snapshot of the facts taken when the dialog opens.
	// svelte-ignore state_referenced_locally
	let workOrder = $state(facts.work_order ?? '');
	// svelte-ignore state_referenced_locally
	let scheduled = $state(local(facts.scheduled_start_at));
	// svelte-ignore state_referenced_locally
	let target = $state(local(facts.target_completion_at));
	// svelte-ignore state_referenced_locally
	let priority = $state(String(facts.priority));
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await store.update({
				work_order_number: workOrder.trim() || undefined,
				scheduled_start_at: scheduled ? new Date(scheduled).toISOString() : undefined,
				target_completion_at: target ? new Date(target).toISOString() : undefined,
				priority: Number(priority)
			});
			onclose();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
	<Dialog.Header><Dialog.Title>Edit work order</Dialog.Title></Dialog.Header>
	<FormRow label="Work order" for="wo-number">
		<Input id="wo-number" bind:value={workOrder} class="font-mono" maxlength={100} />
	</FormRow>
	<div class="grid grid-cols-2 gap-3">
		<FormRow label="Scheduled start" for="wo-sched">
			<Input id="wo-sched" type="datetime-local" bind:value={scheduled} class="font-mono" />
		</FormRow>
		<FormRow label="Target completion" for="wo-target">
			<Input id="wo-target" type="datetime-local" bind:value={target} class="font-mono" />
		</FormRow>
	</div>
	<FormRow label="Priority" for="wo-priority">
		<NativeSelect id="wo-priority" class="w-48" bind:value={priority}>
			<option value="0">NORMAL</option>
			<option value="1">HIGH</option>
			<option value="2">URGENT</option>
		</NativeSelect>
	</FormRow>
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={onclose}>CANCEL</Button>
		<Button type="submit" disabled={busy}>SAVE</Button>
	</Dialog.Footer>
</form>
