<script lang="ts">
	// Record a test result against a stock record, from a part test template or custom.
	import { api } from '#lib/api.js';
	import { toast } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { qty } from '#lib/format.js';
	import type { StockTest, StockTestTemplate } from './types.js';

	let {
		open = $bindable(false),
		inventoryId,
		templates,
		test = null,
		ondone
	}: {
		open: boolean;
		inventoryId: number;
		templates: StockTestTemplate[];
		/** Editing this result; null records a new one. */
		test?: StockTest | null;
		ondone: () => void | Promise<void>;
	} = $props();

	let templateId = $state('');
	let name = $state('');
	let result = $state('pass');
	let value = $state('');
	let notes = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const template = $derived(templates.find((t) => String(t.id) === templateId) ?? null);

	$effect(() => {
		if (!open) return;
		error = null;
		templateId = test?.template_id ? String(test.template_id) : '';
		name = test?.test_name ?? '';
		result = test?.result ?? 'pass';
		value = test?.value ?? '';
		notes = test?.notes ?? '';
	});

	function onTemplate() {
		if (template) name = template.name;
	}

	const range = $derived(
		template && (template.min_value !== null || template.max_value !== null)
			? `${template.min_value !== null ? qty(template.min_value) : '…'} to ${template.max_value !== null ? qty(template.max_value) : '…'}${template.unit ? ` ${template.unit}` : ''}`
			: null
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		busy = true;
		error = null;
		const body = {
			test_name: name.trim(),
			template_id: templateId ? Number(templateId) : null,
			result,
			value: value.trim() || null,
			notes: notes.trim() || null
		};
		try {
			if (test) await api.patch(`/inventory/${inventoryId}/tests/${test.id}`, body);
			else await api.post(`/inventory/${inventoryId}/tests`, body);
			toast.success(`${name.trim()} ${result}`);
			open = false;
			await ondone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="text-sm font-semibold">{test ? 'Edit test' : 'Run test'}</Dialog.Title>
		</Dialog.Header>
		<form onsubmit={submit} class="grid grid-cols-1 gap-3">
			{#if !test && templates.length}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="t-template">Template</Label>
					<NativeSelect
						id="t-template"
						class="w-full"
						bind:value={templateId}
						onchange={onTemplate}
					>
						<option value="">Custom test</option>
						{#each templates as t (t.id)}
							<option value={String(t.id)}>{t.name}{t.required ? ' (required)' : ''}</option>
						{/each}
					</NativeSelect>
				</div>
			{/if}
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="t-name">Test</Label>
				<Input id="t-name" bind:value={name} required readonly={!!template && !test} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="t-result">Result</Label>
				<NativeSelect id="t-result" class="w-full" bind:value={result}>
					<option value="pass">Pass</option>
					<option value="fail">Fail</option>
					<option value="pending">Pending</option>
				</NativeSelect>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="t-value">Value{template?.unit ? ` (${template.unit})` : ''}</Label
				>
				<Input id="t-value" class="font-mono" bind:value />
				{#if range}<p class="font-mono text-xs text-muted-foreground">Range {range}</p>{/if}
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="t-notes">Notes</Label>
				<Textarea id="t-notes" rows={2} bind:value={notes} />
			</div>
			{#if error}
				<p
					role="alert"
					class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
				>
					{error}
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !name.trim()}>{test ? 'SAVE' : 'RECORD'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
