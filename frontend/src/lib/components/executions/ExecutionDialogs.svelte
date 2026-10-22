<script lang="ts">
	// All modal forms of the execution document, driven by store.dialog.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import AttachForm from './AttachForm.svelte';
	import EditForm from './EditForm.svelte';
	import RaiseIssueForm from './RaiseIssueForm.svelte';
	import RedlineForm from './RedlineForm.svelte';
	import SkipForm from './SkipForm.svelte';

	let { store, editing = $bindable(false) }: { store: ExecutionStore; editing?: boolean } =
		$props();

	const open = $derived(!!store.dialog);
	// Keep the last dialog while it animates out; its form must not see a null step.
	let d = $state<typeof store.dialog>(null);
	$effect(() => {
		if (store.dialog) d = store.dialog;
	});
	const wide = $derived(d?.kind === 'issue' || d?.kind === 'redline');
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) store.closeDialog();
	}}
>
	<Dialog.Content class={wide ? 'sm:max-w-xl' : 'sm:max-w-md'}>
		{#if d?.kind === 'issue'}
			<RaiseIssueForm {store} step={d.step} />
		{:else if d?.kind === 'skip'}
			<SkipForm {store} step={d.step} />
		{:else if d?.kind === 'redline'}
			<RedlineForm {store} op={d.op} preselect={d.issueId} />
		{:else if d?.kind === 'attach'}
			<AttachForm {store} step={d.step} />
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editing}>
	<Dialog.Content class="sm:max-w-md">
		{#if store.doc && editing}
			<EditForm {store} facts={store.doc.instance} onclose={() => (editing = false)} />
		{/if}
	</Dialog.Content>
</Dialog.Root>
