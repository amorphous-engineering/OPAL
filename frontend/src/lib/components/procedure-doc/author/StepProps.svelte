<script lang="ts">
	// Properties of an OP or step that the document shows as chips and gates:
	// how long, where; for an OP also contingency, sequence, order.
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { DocOp, DocStep } from '../types.js';

	let { step, op, isOp }: { step: DocStep; op: DocOp; isOp: boolean } = $props();
	const au = useDoc().author!;
	const pid = $derived(`prop-${step.order}`);

	const others = $derived(au.ops().filter((o) => o.order !== op.order));
	const waits = $derived(new Set(op.depends_on ?? []));

	function toggleWait(id: number) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local copy
		const next = new Set(waits);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		au.setDependencies(op, [...next]);
	}
</script>

<div class="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-3">
	<div class="grid grid-cols-1 content-start gap-1">
		<label for={`${pid}-est`} class="label">Estimate (min)</label>
		<Input
			id={`${pid}-est`}
			type="number"
			min="1"
			step="1"
			class="font-mono"
			value={step.estimated_duration_minutes ?? ''}
			onkeydown={(e) => e.stopPropagation()}
			oninput={(e) => {
				const v = e.currentTarget.value;
				au.edit(step, {
					estimated_duration_minutes: v === '' || Number(v) < 1 ? null : Math.round(Number(v))
				});
			}}
		/>
	</div>
	<div class="grid grid-cols-1 content-start gap-1">
		<label for={`${pid}-wc`} class="label">Workcenter</label>
		<NativeSelect
			id={`${pid}-wc`}
			class="w-full"
			value={step.workcenter_id ?? ''}
			onchange={(e) =>
				au.edit(step, {
					workcenter_id: e.currentTarget.value ? Number(e.currentTarget.value) : null
				})}
		>
			<option value="">—</option>
			{#each au.workcenters as w (w.id)}<option value={w.id}>{w.code} {w.name}</option>{/each}
		</NativeSelect>
	</div>
	{#if isOp}
		<div class="grid grid-cols-1 content-start gap-1">
			<span class="label">Contingency</span>
			<label class="flex h-8 items-center gap-2 text-xs">
				<Checkbox
					id={`${pid}-cont`}
					checked={op.is_contingency}
					onCheckedChange={(c) => au.edit(op.step, { is_contingency: !!c })}
				/>
				Yes
			</label>
		</div>
		{#if op.steps.length}
			<div class="grid grid-cols-1 content-start gap-1">
				<span class="label">Sequence</span>
				<label class="flex h-8 items-center gap-2 text-xs">
					<Checkbox
						id={`${pid}-seq`}
						checked={op.strict_sequence}
						onCheckedChange={(c) => au.edit(op.step, { strict_sequence: !!c })}
					/>
					In order
				</label>
			</div>
		{/if}
	{/if}
</div>
{#if isOp}
	<div class="mt-3 grid grid-cols-1 gap-1" data-waits-on>
		<span class="label">Waits on</span>
		<div class="flex flex-wrap gap-1">
			{#each others as o (o.order)}
				<button
					type="button"
					aria-pressed={waits.has(o.order)}
					title={o.title}
					class={cn(
						'inline-flex h-6 items-center border px-2 font-mono text-xs',
						waits.has(o.order)
							? 'border-primary bg-primary text-primary-foreground'
							: 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
					)}
					onclick={() => toggleWait(o.order)}>OP {o.number}</button
				>
			{:else}
				<span class="font-mono text-xs text-muted-foreground">—</span>
			{/each}
		</div>
	</div>
{/if}
