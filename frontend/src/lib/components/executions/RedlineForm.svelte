<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	// Redline: an ad-hoc OP in a running work order, authorised by an open NC on the host OP.
	// It is written as a draft, in place above the OP it gates, and released by the NC's
	// disposition signature. Its steps may use parts, and it may replace lines of the host OP's
	// planned kit.
	import { State, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/parts/types.js';
	import type { DocOp, DocStep } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let {
		store,
		op,
		preselect,
		draft
	}: { store: ExecutionStore; op: DocOp; preselect?: number; draft?: DocOp } = $props();

	type KitLine = { part_id: number; label: string; uom: string; quantity: string };
	type StepDraft = {
		title: string;
		instructions: string;
		requires_signoff: boolean;
		kit: KitLine[];
	};

	const fromStep = (s: DocStep): StepDraft => ({
		title: s.title,
		instructions: s.instructions ?? '',
		requires_signoff: (s.signoffs ?? []).length > 1,
		kit: s.step_kit.map((k) => ({
			part_id: k.part_id,
			label: [k.part_number, k.part_name].filter(Boolean).join(' '),
			uom: k.uom ?? 'ea',
			quantity: String(k.quantity_required)
		}))
	});
	const blankStep = (): StepDraft => ({
		title: '',
		instructions: '',
		requires_signoff: false,
		kit: []
	});

	// svelte-ignore state_referenced_locally
	let issueId = $state(
		String(
			draft?.redline?.issue_id ??
				op.open_ncs.find((n) => n.id === preselect)?.id ??
				op.open_ncs[0]?.id ??
				''
		)
	);
	// svelte-ignore state_referenced_locally
	let title = $state(draft?.title ?? '');
	// svelte-ignore state_referenced_locally
	let steps = $state<StepDraft[]>(draft ? draft.steps.map(fromStep) : [blankStep()]);

	/** The host OP's planned kit lines, by step: what a redline may replace. */
	const planned = $derived(
		[op.step, ...op.steps].flatMap((s) =>
			s.step_kit
				.filter((k) => k.usage_type !== 'tooling' && !k.struck_by)
				.map((k) => ({
					key: `${s.order}:${k.part_id}`,
					step_order: s.order,
					step_number: s.number,
					part_id: k.part_id,
					label: [k.part_number, k.part_name].filter(Boolean).join(' '),
					quantity: k.quantity_required,
					uom: k.uom ?? 'ea'
				}))
		)
	);
	// svelte-ignore state_referenced_locally
	const struck = new SvelteSet(
		(draft?.redline?.strikes ?? []).map((x) => `${x.step_order}:${x.part_id}`)
	);
	const toggleStrike = (key: string) => {
		if (!struck.delete(key)) struck.add(key);
	};

	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await store.saveRedline({
				redlineId: draft?.step.execution_id,
				issueId: Number(issueId),
				title: title.trim(),
				steps: steps.map((s) => ({
					title: s.title.trim(),
					instructions: s.instructions.trim() || null,
					requiresSignoff: s.requires_signoff,
					kit: s.kit
						.filter((k) => Number(k.quantity) > 0)
						.map((k) => ({ partId: k.part_id, quantity: k.quantity.trim() }))
				})),
				strikes: planned
					.filter((p) => struck.has(p.key))
					.map((p) => ({ stepId: p.step_order, partId: p.part_id }))
			});
			store.closePanel();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Redline not saved';
			toastError(err);
		} finally {
			busy = false;
		}
	}

	// The form opens where the redline will sit; bring it into view from wherever it was opened.
	function reveal(node: HTMLElement) {
		node.scrollIntoView({ block: 'start' });
		node.querySelector<HTMLInputElement>('#rl-title')?.focus({ preventScroll: true });
	}
</script>

<!-- Dashed: a draft is pencil. It sits where the redline will, above the OP it gates. -->
<form
	use:reveal
	class="grid scroll-mt-14 grid-cols-1 gap-3 border border-dashed border-foreground bg-card p-3"
	aria-label={draft ? `Edit redline ${draft.number}` : 'Write redline OP'}
	onsubmit={submit}
>
	<div class="flex flex-wrap items-baseline gap-2">
		<span class="font-mono text-sm font-semibold text-tan"
			>{draft ? `OP ${draft.number}` : 'Redline'}</span
		>
		<span class="text-sm text-muted-foreground">gates OP {op.number} {op.title}</span>
		<State value="draft" class="ml-auto" />
	</div>
	{#if !draft && op.open_ncs.length > 1}
		<FormRow label="Issue" for="rl-issue" required>
			<NativeSelect id="rl-issue" class="w-full" bind:value={issueId} required>
				{#each op.open_ncs as nc (nc.id)}
					<option value={String(nc.id)}>{nc.issue_number} {nc.title}</option>
				{/each}
			</NativeSelect>
		</FormRow>
	{/if}
	<FormRow label="Title" for="rl-title" required>
		<Input id="rl-title" bind:value={title} maxlength={255} required />
	</FormRow>
	<div class="grid grid-cols-1 gap-2">
		<span class="label">Steps</span>
		{#each steps as s, i (i)}
			<div class="grid grid-cols-1 gap-1.5 border border-dashed border-foreground p-2">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-mono text-xs text-muted-foreground">{i + 1}.</span>
					<Input
						class="min-w-0 flex-1"
						bind:value={s.title}
						placeholder="Step title"
						maxlength={255}
						required
						aria-label={`Step ${i + 1} title`}
					/>
					<label class="flex items-center gap-1.5 text-xs whitespace-nowrap">
						<Checkbox bind:checked={s.requires_signoff} />
						<span class="font-mono">+ SECOND SIGN-OFF</span>
					</label>
					<Button
						size="sm"
						variant="ghost"
						disabled={steps.length === 1}
						onclick={() => (steps = steps.filter((_, j) => j !== i))}>REMOVE</Button
					>
				</div>
				<MarkdownField
					bind:value={s.instructions}
					ariaLabel={`Step ${i + 1} instructions`}
					placeholder="Instructions"
					minRows={2}
				/>
				{#if s.kit.length}
					<ul class="grid grid-cols-1 gap-1">
						{#each s.kit as k, j (k.part_id)}
							<li class="flex flex-wrap items-center gap-2 text-sm">
								<span class="min-w-0 flex-1 truncate">{k.label}</span>
								<Input
									class="w-20 text-right font-mono"
									inputmode="decimal"
									bind:value={k.quantity}
									aria-label={`${k.label} quantity`}
								/>
								<span class="w-8 font-mono text-xs text-muted-foreground">{k.uom}</span>
								<Button
									size="sm"
									variant="ghost"
									onclick={() => (s.kit = s.kit.filter((_, x) => x !== j))}>REMOVE</Button
								>
							</li>
						{/each}
					</ul>
				{/if}
				<div>
					<PartPicker
						activeOnly
						exclude={s.kit.map((k) => k.part_id)}
						onselect={(p: PickedPart | null) => {
							if (p)
								s.kit = [
									...s.kit,
									{
										part_id: p.id,
										label: [p.internal_pn, p.name].filter(Boolean).join(' '),
										uom: p.unit_of_measure,
										quantity: '1'
									}
								];
						}}
					>
						{#snippet trigger({ props })}
							<Button {...props} size="sm" variant="outline">+ PART</Button>
						{/snippet}
					</PartPicker>
				</div>
			</div>
		{/each}
		<div>
			<Button size="sm" variant="outline" onclick={() => (steps = [...steps, blankStep()])}
				>+ STEP</Button
			>
		</div>
	</div>
	{#if planned.length}
		<div class="grid grid-cols-1 gap-1">
			<span class="label">Replaces from OP {op.number}'s kit</span>
			{#each planned as p (p.key)}
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={struck.has(p.key)} onCheckedChange={() => toggleStrike(p.key)} />
					<span class={['min-w-0 flex-1 truncate', struck.has(p.key) && 'line-through']}
						>{p.label}</span
					>
					<span class={['font-mono', struck.has(p.key) && 'line-through']}
						>{p.quantity} {p.uom}</span
					>
					<span class="w-10 font-mono text-xs text-muted-foreground">{p.step_number}</span>
				</label>
			{/each}
		</div>
	{/if}
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<div class="flex justify-end gap-2">
		<Button variant="ghost" onclick={() => store.closePanel()}>CANCEL</Button>
		<Button type="submit" disabled={busy || !title.trim() || steps.some((s) => !s.title.trim())}
			>SAVE DRAFT</Button
		>
	</div>
</form>
