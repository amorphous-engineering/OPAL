<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { confirmState } from './confirm.svelte';

	let typed = $state('');
	const o = $derived(confirmState.options);
	const blocked = $derived(!!o.typeToConfirm && typed !== o.typeToConfirm);

	$effect(() => {
		if (confirmState.open) typed = '';
	});
</script>

<AlertDialog.Root
	open={confirmState.open}
	onOpenChange={(v) => {
		if (!v) confirmState.settle(false);
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{o.title}</AlertDialog.Title>
			{#if o.body}<AlertDialog.Description>{o.body}</AlertDialog.Description>{/if}
		</AlertDialog.Header>
		{#if o.typeToConfirm}
			<label class="grid gap-1.5 text-xs">
				<span class="label"
					>Type <span class="font-mono text-foreground normal-case">{o.typeToConfirm}</span></span
				>
				<Input bind:value={typed} autocomplete="off" />
			</label>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => confirmState.settle(false)}>CANCEL</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={blocked}
				class={o.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : ''}
				onclick={() => confirmState.settle(true)}>{o.action ?? 'CONFIRM'}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
