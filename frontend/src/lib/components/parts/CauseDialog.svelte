<script lang="ts">
	// Activate or retire a part with the cause on record. The cause is the reason a person
	// gives later when asked why the identity locked or the part left service.
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import FormField from './FormField.svelte';

	let {
		open = $bindable(false),
		title,
		body,
		action,
		placeholder,
		destructive = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		/** The consequence sentence. */
		body: string;
		action: string;
		placeholder: string;
		destructive?: boolean;
		onconfirm: (cause: string | undefined) => Promise<boolean>;
	} = $props();

	let cause = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await onconfirm(cause.trim() || undefined);
		busy = false;
		if (ok) {
			open = false;
			cause = '';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{body}</Dialog.Description>
		</Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<FormField label="Cause" for="cause-input">
				<Input id="cause-input" bind:value={cause} {placeholder} maxlength={255} autocomplete="off" />
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}
					>{action}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
