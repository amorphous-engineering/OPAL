<script lang="ts">
	// Data capture for a step, from its schema. Values live in the controller
	// (drafts), never in this component, so a document refresh cannot clobber
	// what the operator is typing. Saved with the first sign-off.
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import FieldEditor from './author/FieldEditor.svelte';
	import { attachmentUrl, gallery } from './viewer.js';
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
	const filled = (v: unknown) =>
		v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
	const required = $derived(fields.filter((f) => f.required));
	const recorded = $derived(
		required.filter((f) => filled(ctl.fieldValue(step, f.name)) || f.type === 'checkbox').length
	);
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

{#if fields.length || authoring}
	<!-- Data capture is its own panel: one field per row, label and spec on the
	     left, the input on the right, so it never reads as part of the prose. -->
	<section class="border border-border bg-muted/40" aria-label="Data capture">
		<header class="flex h-8 items-center gap-3 border-b border-border px-3">
			<span class="label text-foreground">Data</span>
			{#if required.length}
				<span
					class={cn(
						'font-mono text-[11px]',
						recorded === required.length ? 'text-ok' : 'text-muted-foreground'
					)}>{recorded}/{required.length} required recorded</span
				>
			{:else if fields.length}
				<span class="font-mono text-[11px] text-muted-foreground"
					>{fields.length} {fields.length === 1 ? 'field' : 'fields'}</span
				>
			{/if}
			{#if authoring}
				<span class="ml-auto"
					><Button size="xs" variant="outline" onclick={addField}>+ FIELD</Button></span
				>
			{/if}
		</header>
		{#if !fields.length}
			<p class="px-3 py-2 font-mono text-xs text-muted-foreground">none</p>
		{/if}
		{#each fields as f, i (authoring ? i : f.name)}
			{@const id = `cap-${step.order}-${f.name}`}
			{@const err = errors[f.name]}
			<div
				class="grid items-start gap-x-6 gap-y-1.5 border-t border-border px-3 py-2.5 first-of-type:border-t-0 sm:grid-cols-[minmax(10rem,18rem)_minmax(0,26rem)]"
			>
				<div class="grid gap-0.5 sm:pt-1.5">
					<label for={id} class="text-sm font-medium text-foreground">
						{f.label ?? f.name}{#if f.required}<span class="text-error" title="Required">
								*</span
							>{/if}
					</label>
					{#if f.unit || f.min != null || f.max != null}
						<span class="font-mono text-[11px] text-muted-foreground"
							>{#if f.min != null || f.max != null}{f.min ?? '…'} – {f.max ??
									'…'}{/if}{#if f.unit}{f.min != null || f.max != null
									? ' '
									: ''}{f.unit}{/if}</span
						>
					{/if}
				</div>
				<div class="grid min-w-0 gap-1">
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
								<div class="flex flex-wrap gap-2" use:gallery>
									{#each photos as pid (pid)}
										<div class="grid gap-1">
											<a
												data-pswp
												href={attachmentUrl(pid)}
												data-pswp-caption={f.label ?? f.name}
												class="block aspect-[4/3] h-16 overflow-hidden border border-border bg-muted"
												aria-label={`Enlarge ${f.label ?? f.name}`}
											>
												<img
													loading="lazy"
													src={attachmentUrl(pid)}
													alt={f.label ?? f.name}
													class="size-full object-cover"
												/>
											</a>
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
				</div>
				{#if authoring}<div class="sm:col-span-2"><FieldEditor {step} index={i} /></div>{/if}
			</div>
		{/each}
	</section>
{/if}
