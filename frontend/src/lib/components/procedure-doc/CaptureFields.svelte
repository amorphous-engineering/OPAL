<script lang="ts">
	// Data capture for a step, from its schema. Values live in the controller
	// (drafts), never in this component, so a document refresh cannot clobber
	// what the operator is typing. Saved with COMPLETE.
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { useDoc } from './controller.js';
	import FieldEditor from './author/FieldEditor.svelte';
	import { attachmentUrl, lightbox } from './lightbox.svelte.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();

	const fields = $derived(step.data_schema?.fields ?? []);
	const authoring = $derived(ctl.mode === 'author');

	function addField() {
		let n = fields.length + 1;
		while (fields.some((f) => f.name === `field_${n}`)) n++;
		ctl.author?.edit(step, {
			data_schema: {
				...(step.data_schema ?? {}),
				fields: [...fields, { name: `field_${n}`, label: 'Field', type: 'text' }]
			}
		});
	}
	const errors = $derived(ctl.fieldErrors(step));
	let uploading = $state(false);

	const ids = (v: unknown): number[] =>
		Array.isArray(v) ? (v as number[]) : typeof v === 'number' ? [v] : [];
	const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

	async function pick(name: string, multiple: boolean, e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
		input.value = '';
		if (!files.length || !ctl.actions.uploadPhotos) return;
		uploading = true;
		try {
			const added = await ctl.actions.uploadPhotos(step, files);
			const current = ids(ctl.fieldValue(step, name));
			ctl.setField(step, name, multiple ? [...current, ...added] : added.slice(-1));
		} catch (err) {
			toastError(err, 'Photo upload failed');
		} finally {
			uploading = false;
		}
	}

	function removePhoto(name: string, id: number) {
		ctl.setField(
			step,
			name,
			ids(ctl.fieldValue(step, name)).filter((x) => x !== id)
		);
	}
</script>

{#if authoring}
	<div class="flex items-center gap-2">
		<span class="label">Data capture</span>
		<Button size="xs" variant="outline" onclick={addField}>+ FIELD</Button>
		{#if !fields.length}<span class="font-mono text-xs text-muted-foreground">none</span>{/if}
	</div>
{/if}
{#if fields.length}
	<div class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-4 gap-y-3">
		{#each fields as f, i (authoring ? i : f.name)}
			{@const id = `cap-${step.order}-${f.name}`}
			{@const err = errors[f.name]}
			<div class="grid content-start gap-1">
				<label for={id} class="label">
					{f.label ?? f.name}{#if f.unit}&nbsp;({f.unit}){/if}{#if f.required}<span
							class="text-error"
						>
							*</span
						>{/if}
				</label>
				{#if f.type === 'number'}
					<Input
						{id}
						type="number"
						min={f.min}
						max={f.max}
						step={f.step ?? 'any'}
						class="font-mono"
						aria-invalid={!!err}
						value={text(ctl.fieldValue(step, f.name))}
						oninput={(e) => {
							const v = (e.currentTarget as HTMLInputElement).value;
							ctl.setField(step, f.name, v === '' ? null : Number(v));
						}}
					/>
				{:else if f.type === 'checkbox'}
					<div class="flex h-8 items-center gap-2">
						<Checkbox
							{id}
							checked={!!ctl.fieldValue(step, f.name)}
							onCheckedChange={(c) => ctl.setField(step, f.name, !!c)}
						/>
						<span class="text-xs">{f.label ?? f.name}</span>
					</div>
				{:else if f.type === 'select'}
					<NativeSelect
						{id}
						class="w-full"
						aria-invalid={!!err}
						value={text(ctl.fieldValue(step, f.name))}
						onchange={(e) => ctl.setField(step, f.name, e.currentTarget.value || null)}
					>
						<option value="">—</option>
						{#each f.options ?? [] as opt (opt)}<option value={opt}>{opt}</option>{/each}
					</NativeSelect>
				{:else if f.type === 'textarea'}
					<Textarea
						{id}
						rows={f.rows ?? 2}
						aria-invalid={!!err}
						value={text(ctl.fieldValue(step, f.name))}
						oninput={(e) => ctl.setField(step, f.name, e.currentTarget.value || null)}
					/>
				{:else if f.type === 'photo'}
					{@const photos = ids(ctl.fieldValue(step, f.name))}
					<div class="grid gap-1.5">
						{#if photos.length}
							<div class="flex flex-wrap gap-2">
								{#each photos as pid (pid)}
									<div class="grid gap-1">
										<button
											type="button"
											class="block border border-border"
											onclick={() => lightbox.open(attachmentUrl(pid), f.label ?? f.name)}
											aria-label={`Enlarge ${f.label ?? f.name}`}
										>
											<img
												loading="lazy"
												src={attachmentUrl(pid)}
												alt={f.label ?? f.name}
												class="h-16 w-auto object-cover"
											/>
										</button>
										<Button
											size="xs"
											variant="outline"
											onclick={() => removePhoto(f.name, pid)}
											aria-label={`Remove photo ${pid}`}>REMOVE</Button
										>
									</div>
								{/each}
							</div>
						{/if}
						<Input
							{id}
							type="file"
							accept="image/*"
							capture="environment"
							multiple={!!f.multiple}
							disabled={uploading || authoring}
							onchange={(e) => pick(f.name, !!f.multiple, e)}
						/>
					</div>
				{:else}
					<Input
						{id}
						type="text"
						placeholder={f.placeholder}
						aria-invalid={!!err}
						value={text(ctl.fieldValue(step, f.name))}
						oninput={(e) => ctl.setField(step, f.name, e.currentTarget.value || null)}
					/>
				{/if}
				{#if err}<p class="text-[11px] text-error">{err}</p>{/if}
				{#if authoring}<FieldEditor {step} index={i} />{/if}
			</div>
		{/each}
	</div>
{/if}
