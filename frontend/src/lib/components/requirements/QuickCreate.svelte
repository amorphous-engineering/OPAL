<script lang="ts">
	// Flow-down in two fields: title and statement. Parent, level and category
	// come from the row it was opened from (context pre-fill). The dialog stays
	// open after a create so a decomposition can be entered in one sitting.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api } from '#lib/api.js';
	import { toast, toastError } from '#lib/components/opal/index.js';
	import LintEditor from './LintEditor.svelte';

	export interface QuickParent {
		id: number;
		req_number: string;
		level: number;
		category: string | null;
	}

	let {
		open = $bindable(false),
		parent = null,
		oncreated
	}: {
		open?: boolean;
		parent?: QuickParent | null;
		oncreated?: (created: { id: number; req_number: string }) => void;
	} = $props();

	let title = $state('');
	let statement = $state('');
	let busy = $state(false);
	let titleEl = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (open) {
			title = '';
			statement = '';
			queueMicrotask(() => titleEl?.focus());
		}
	});

	async function submit(e?: SubmitEvent) {
		e?.preventDefault();
		if (!title.trim() || !statement.trim() || busy) return;
		busy = true;
		try {
			const created = await api.post<{ id: number; req_number: string }>('/requirements', {
				title: title.trim(),
				statement: statement.trim(),
				parent_id: parent?.id ?? null,
				category: parent?.category ?? null
			});
			toast.success(`${created.req_number} created`);
			title = '';
			statement = '';
			titleEl?.focus();
			oncreated?.(created);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		if (open && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
	}
</script>

<svelte:window onkeydown={keydown} />

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>
				{parent ? `Flow down from ${parent.req_number}` : 'New level-0 requirement'}
			</Dialog.Title>
		</Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="qc-title">Title</Label>
				<Input id="qc-title" bind:ref={titleEl} bind:value={title} maxlength={255} required />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="qc-statement">Shall statement</Label>
				<LintEditor
					id="qc-statement"
					bind:value={statement}
					placeholder="The <subject> shall <one thought>"
					required
				/>
			</div>
			<Dialog.Footer class="items-center">
				<span class="mr-auto font-mono text-xs text-muted-foreground">⌘↵ create</span>
				<Dialog.Close>
					{#snippet child({ props })}<Button variant="outline" {...props}>DONE</Button>{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={busy || !title.trim() || !statement.trim()}>CREATE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
