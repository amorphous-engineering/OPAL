<script lang="ts">
	// One data-capture field's definition, under the live input the operator
	// will get. Edits write the step's schema.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { specFromLabel, specText, unitByCode, zDecimal, zSpec, SPEC_KINDS } from '@opal/shared';
	import type { Spec, SpecKind } from '@opal/shared';
	import UnitPicker from '#lib/components/opal/UnitPicker.svelte';
	import { useDoc } from '../controller.js';
	import type { DocField, DocStep } from '../types.js';

	let { step, index }: { step: DocStep; index: number } = $props();
	const au = useDoc().author!;

	const fields = $derived(step.data_schema?.fields ?? []);
	const f = $derived(fields[index]);
	const id = $derived(`fld-${step.order}-${index}`);

	const FIELD_TYPES = [
		['text', 'TEXT'],
		['number', 'NUMBER'],
		['boolean', 'BOOLEAN'],
		['select', 'SELECT'],
		['textarea', 'NOTES'],
		['photo', 'PHOTO']
	] as const;

	function save(next: DocField[]) {
		au.edit(step, { data_schema: { ...(step.data_schema ?? {}), fields: next } });
	}

	function patch(p: Partial<DocField>, drop: (keyof DocField)[] = []) {
		const next = fields.map((x, i) => {
			if (i !== index) return x;
			const merged: Record<string, unknown> = { ...x, ...p };
			for (const k of drop) delete merged[k];
			for (const k of Object.keys(merged))
				if (merged[k] === undefined || merged[k] === '') delete merged[k];
			return merged as unknown as DocField;
		});
		save(next);
	}

	// The key (f.name) is fixed when the field is added; the label is free text.
	const setLabel = (label: string) => patch({ label });

	// The spec editor keeps its own strings: half-typed numbers are not a spec yet. The stored
	// spec changes only when the strings make a valid one.
	const KIND_LABELS: Record<SpecKind | 'none', string> = {
		none: 'NO SPEC',
		range: 'RANGE',
		nominal: 'NOMINAL ±',
		min: 'MINIMUM',
		max: 'MAXIMUM',
		reference: 'REFERENCE'
	};
	const KIND_INPUTS: Record<SpecKind, [keyof SpecDraft, string][]> = {
		range: [
			['lower', 'Lower'],
			['upper', 'Upper']
		],
		nominal: [
			['nominal', 'Nominal'],
			['plus', 'Plus'],
			['minus', 'Minus']
		],
		min: [['lower', 'Lower']],
		max: [['upper', 'Upper']],
		reference: [['nominal', 'Nominal']]
	};
	interface SpecDraft {
		kind: SpecKind | 'none';
		lower: string;
		upper: string;
		nominal: string;
		plus: string;
		minus: string;
	}
	const draftOf = (s: Spec | undefined): SpecDraft => ({
		kind: s?.kind ?? 'none',
		lower: '',
		upper: '',
		nominal: '',
		plus: '',
		minus: '',
		...(s ?? {})
	});
	let draft = $state<SpecDraft>(draftOf(undefined));

	function build(d: SpecDraft): { spec?: Spec; errors: Partial<Record<keyof SpecDraft, string>> } {
		if (d.kind === 'none') return { errors: {} };
		const errors: Partial<Record<keyof SpecDraft, string>> = {};
		const spec: Record<string, string> = { kind: d.kind };
		for (const [k] of KIND_INPUTS[d.kind]) {
			const r = zDecimal.safeParse(d[k]);
			if (r.success) spec[k] = r.data;
			else if (d[k] !== '') errors[k] = 'Not a decimal number';
		}
		if (Object.keys(errors).length || KIND_INPUTS[d.kind].some(([k]) => spec[k] === undefined))
			return { errors };
		const r = zSpec.safeParse(spec);
		if (r.success) return { spec: r.data, errors };
		for (const i of r.error.issues) errors[i.path[0] as keyof SpecDraft] = i.message;
		return { errors };
	}
	const built = $derived(build(draft));

	// Follow the stored spec when it changes from outside (SUGGEST, CONVERT, undo).
	$effect(() => {
		const stored = f?.spec;
		if (stored && JSON.stringify(stored) !== JSON.stringify(built.spec)) draft = draftOf(stored);
	});

	function editSpec(p: Partial<SpecDraft>) {
		const prevKind = draft.kind;
		draft = { ...draft, ...p };
		if (draft.kind === 'none') return patch({}, ['spec']);
		const b = build(draft);
		if (b.spec) patch({ spec: b.spec });
		else if (draft.kind !== prevKind) patch({}, ['spec']);
	}

	const legacy = $derived(f && f.type === 'number' && !f.spec && (f.min != null || f.max != null));
	function convertLimits() {
		const spec: Spec =
			f.min != null && f.max != null
				? { kind: 'range', lower: String(f.min), upper: String(f.max) }
				: f.min != null
					? { kind: 'min', lower: String(f.min) }
					: { kind: 'max', upper: String(f.max) };
		patch({ spec }, ['min', 'max']);
		draft = draftOf(spec);
	}

	const suggestion = $derived(f?.type === 'number' ? specFromLabel(f.label ?? '') : null);
	function applySuggestion() {
		if (!suggestion?.spec) return;
		patch({
			label: suggestion.label,
			spec: suggestion.spec,
			...(suggestion.unit ? { unit: suggestion.unit } : {})
		});
		draft = draftOf(suggestion.spec);
	}

	function move(dir: -1 | 1) {
		const j = index + dir;
		if (j < 0 || j >= fields.length) return;
		const next = [...fields];
		[next[index], next[j]] = [next[j], next[index]];
		save(next);
	}

	function remove() {
		save(fields.filter((_, i) => i !== index));
	}

	function setType(type: string) {
		const drop: (keyof DocField)[] = [];
		if (type !== 'number') drop.push('min', 'max', 'step', 'spec');
		if (type !== 'select') drop.push('options');
		if (type !== 'photo') drop.push('multiple');
		if (type === 'select' && !f.options?.length) patch({ type, options: ['A', 'B'] }, drop);
		else patch({ type }, drop);
	}

	const stop = (e: KeyboardEvent) => e.stopPropagation();
</script>

{#if f}
	<div
		class="mt-1 grid grid-cols-1 gap-1.5 rounded-md border border-dashed border-border bg-muted/30 p-1.5"
		data-field-editor
	>
		<div class="grid grid-cols-2 gap-1.5">
			<Input
				id={`${id}-label`}
				class="h-7"
				aria-label="Label"
				placeholder="Label"
				value={f.label ?? ''}
				onkeydown={stop}
				oninput={(e) => setLabel(e.currentTarget.value)}
			/>
			<NativeSelect
				size="sm"
				aria-label="Type"
				value={f.type}
				onchange={(e) => setType(e.currentTarget.value)}
			>
				{#each FIELD_TYPES as [v, l] (v)}<option value={v}>{l}</option>{/each}
			</NativeSelect>
		</div>
		<div class="flex flex-wrap items-center gap-1.5">
			<span
				class="w-32 truncate font-mono text-xs text-muted-foreground"
				title="Key under which the value is recorded">{f.name}</span
			>
			{#if f.type === 'number'}
				<UnitPicker
					value={f.unit}
					onchange={(code) => patch(code ? { unit: code } : {}, code ? [] : ['unit'])}
				/>
				{#if f.unit && !unitByCode(f.unit)}
					<span class="text-xs text-warn">Free-text unit: pick a unit</span>
				{/if}
			{:else if f.type === 'text'}
				<Input
					class="h-7 w-16 font-mono"
					aria-label="Unit"
					placeholder="Unit"
					value={f.unit ?? ''}
					onkeydown={stop}
					oninput={(e) =>
						patch({ unit: e.currentTarget.value }, e.currentTarget.value ? [] : ['unit'])}
				/>
			{/if}
			<label class="flex items-center gap-1.5 text-xs">
				<Checkbox
					checked={!!f.required}
					onCheckedChange={(c) => patch({ required: c ? true : undefined }, c ? [] : ['required'])}
				/>Required
			</label>
			{#if f.type === 'photo'}
				<label class="flex items-center gap-1.5 text-xs">
					<Checkbox
						checked={!!f.multiple}
						onCheckedChange={(c) =>
							patch({ multiple: c ? true : undefined }, c ? [] : ['multiple'])}
					/>Several
				</label>
			{/if}
			<span class="ml-auto flex items-center gap-0.5">
				<Button size="xs" variant="ghost" aria-label="Move field up" onclick={() => move(-1)}
					>↑</Button
				>
				<Button size="xs" variant="ghost" aria-label="Move field down" onclick={() => move(1)}
					>↓</Button
				>
				<Button size="xs" variant="ghost" aria-label="Remove field" onclick={remove}>REMOVE</Button>
			</span>
		</div>
		{#if f.type === 'number'}
			<div class="flex flex-wrap items-center gap-1.5" data-spec-editor>
				<NativeSelect
					size="sm"
					aria-label="Spec kind"
					value={draft.kind}
					onchange={(e) => editSpec({ kind: e.currentTarget.value as SpecKind | 'none' })}
				>
					{#each ['none', ...SPEC_KINDS] as k (k)}
						<option value={k}>{KIND_LABELS[k as SpecKind | 'none']}</option>
					{/each}
				</NativeSelect>
				{#if draft.kind !== 'none'}
					{#each KIND_INPUTS[draft.kind] as [key, name] (key)}
						{@const label = draft.kind === 'nominal' && key === 'minus' ? 'Minus' : name}
						<span class="label">{label}</span>
						<Input
							type="text"
							inputmode="decimal"
							class="h-7 w-24 font-mono"
							aria-label={label}
							aria-invalid={!!built.errors[key]}
							value={draft[key as keyof SpecDraft]}
							onkeydown={stop}
							oninput={(e) => editSpec({ [key]: e.currentTarget.value })}
						/>
					{/each}
				{/if}
				{#if suggestion?.spec}
					<Button
						size="xs"
						variant="outline"
						title={`${specText(suggestion?.spec, suggestion?.unit)} from the label`}
						onclick={applySuggestion}>SUGGEST SPEC</Button
					>
				{/if}
			</div>
			{#each Object.entries(built.errors) as [k, msg] (k)}
				<p class="text-xs text-error">{msg}</p>
			{/each}
			{#if legacy}
				<div class="flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
					<span>Min {f.min ?? '…'}</span><span>Max {f.max ?? '…'}</span>
					<Button size="xs" variant="outline" onclick={convertLimits}>CONVERT TO SPEC</Button>
				</div>
			{/if}
			{#if f.spec}
				<p class="font-mono text-xs text-muted-foreground">Spec {specText(f.spec, f.unit)}</p>
			{/if}
		{/if}
		{#if f.type === 'select'}
			<Input
				class="h-7"
				aria-label="Options"
				placeholder="Options, comma separated"
				value={(f.options ?? []).join(', ')}
				onkeydown={stop}
				onchange={(e) =>
					patch({
						options: e.currentTarget.value
							.split(',')
							.map((x) => x.trim())
							.filter(Boolean)
					})}
			/>
		{/if}
	</div>
{/if}
