<script lang="ts">
	// One data-capture field's definition, under the live input the operator
	// will get. Edits write the step's schema.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
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
		['checkbox', 'CHECKBOX'],
		['select', 'SELECT'],
		['textarea', 'NOTES'],
		['photo', 'PHOTO']
	] as const;

	const slug = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '');
	const taken = (name: string) => fields.some((x, i) => i !== index && x.name === name);

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

	function setLabel(label: string) {
		// The name follows the label until the author sets it by hand.
		const linked = !f.name || f.name === slug(f.label ?? '') || /^field_\d+$/.test(f.name);
		let name = f.name;
		if (linked) {
			let base = slug(label) || f.name;
			let n = 2;
			let candidate = base;
			while (taken(candidate)) candidate = `${base}_${n++}`;
			name = candidate;
		}
		patch({ label, name });
	}

	function setName(raw: string) {
		const name = slug(raw);
		if (!name || taken(name)) return;
		patch({ name });
	}

	function setNumber(key: 'min' | 'max', raw: string) {
		if (raw === '') patch({}, [key]);
		else patch({ [key]: Number(raw) } as Partial<DocField>);
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
		if (type !== 'number') drop.push('min', 'max', 'step');
		if (type !== 'select') drop.push('options');
		if (type !== 'photo') drop.push('multiple');
		if (type === 'select' && !f.options?.length) patch({ type, options: ['A', 'B'] }, drop);
		else patch({ type }, drop);
	}

	const stop = (e: KeyboardEvent) => e.stopPropagation();
	const dup = $derived(f ? taken(f.name) : false);
</script>

{#if f}
	<div
		class="mt-1 grid gap-1.5 border border-dashed border-border bg-muted/30 p-1.5"
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
			<Input
				class="h-7 w-32 font-mono"
				aria-label="Name"
				aria-invalid={dup}
				title="Key under which the value is recorded"
				value={f.name}
				onkeydown={stop}
				onchange={(e) => {
					setName(e.currentTarget.value);
					e.currentTarget.value = f.name;
				}}
			/>
			{#if f.type === 'number' || f.type === 'text'}
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
			{#if f.type === 'number'}
				<span class="label">Min</span>
				<Input
					type="number"
					class="h-7 w-20 font-mono"
					aria-label="Minimum"
					placeholder="Min"
					value={f.min ?? ''}
					onkeydown={stop}
					oninput={(e) => setNumber('min', e.currentTarget.value)}
				/>
				<span class="label">Max</span>
				<Input
					type="number"
					class="h-7 w-20 font-mono"
					aria-label="Maximum"
					placeholder="Max"
					value={f.max ?? ''}
					onkeydown={stop}
					oninput={(e) => setNumber('max', e.currentTarget.value)}
				/>
			{/if}
			{#if f.type !== 'checkbox'}
				<label class="flex items-center gap-1.5 text-xs">
					<Checkbox
						checked={!!f.required}
						onCheckedChange={(c) =>
							patch({ required: c ? true : undefined }, c ? [] : ['required'])}
					/>Required
				</label>
			{/if}
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
		{#if dup}<p class="text-[11px] text-error">Name already used by another field</p>{/if}
	</div>
{/if}
