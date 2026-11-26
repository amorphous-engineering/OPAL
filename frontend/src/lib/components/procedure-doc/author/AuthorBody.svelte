<script lang="ts">
	// The editor for one OP or step: what it has, in reading order, then one ADD bank for what it
	// does not have yet. An empty section is absent rather than drawn as "none" (STYLE.md, edit
	// mode). `head` is an OP with sub-steps: its own row holds instructions, callouts, parts,
	// sign-offs, role, duration and units, and its steps hold the rest. Images and data an OP
	// stored before it got sub-steps still show here, so they can be seen and removed.
	import { BankKey, KeyBank, toastError } from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { offeredIn, roleList, type Role } from '#lib/components/users/roles.js';
	import UnitSlotsEditor from '#lib/components/units/UnitSlotsEditor.svelte';
	import CaptureFields from '../CaptureFields.svelte';
	import StepImages from '../StepImages.svelte';
	import { useDoc, type PartHit } from '../controller.js';
	import type { Callout, DocOp, DocStep } from '../types.js';
	import CalloutsEditor from './CalloutsEditor.svelte';
	import KitEditor from './KitEditor.svelte';
	import MarkdownEditor from './MarkdownEditor.svelte';
	import SaveBadge from './SaveBadge.svelte';
	import SignoffEditor from './SignoffEditor.svelte';
	import { focusWhenDrawn } from './focus.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const au = useDoc().author!;

	const isOp = $derived(op.step === step);
	const head = $derived(isOp && op.steps.length > 0);
	const pid = $derived(`prop-${step.order}`);

	let images = $state<ReturnType<typeof StepImages> | null>(null);
	let fields = $state<ReturnType<typeof CaptureFields> | null>(null);
	let kit = $state<ReturnType<typeof KitEditor> | null>(null);
	let unitSlots = $state<ReturnType<typeof UnitSlotsEditor> | null>(null);
	let signoff = $state<ReturnType<typeof SignoffEditor> | null>(null);
	let signoffOpen = $state(false);
	// Opened from ADD and not filled in yet: shown until the editor is closed.
	let roleOpen = $state(false);
	let durationOpen = $state(false);

	const hasRole = $derived(!!step.performer || roleOpen);
	const hasDuration = $derived(step.estimated_duration_minutes != null || durationOpen);
	const hasFields = $derived((step.data_schema?.fields?.length ?? 0) > 0);
	const signoffShown = $derived.by(() => {
		const rows = step.signoff_defs ?? [];
		return signoffOpen || (head ? rows.length > 0 : rows.length > 1 || !!rows[0]?.role);
	});
	const taken = $derived(step.step_kit.map((k) => k.part_id));

	let roles = $state<Role[]>([]);
	$effect(() => {
		roleList()
			.then((r) => (roles = offeredIn(r, au.projectId)))
			.catch(toastError);
	});
	const lc = (s: string) => s.toLowerCase();
	const performer = $derived(step.performer?.name ?? '');
	/** The step's own role when it no longer exists, so the select still shows it. */
	const gone = $derived(
		performer && !roles.some((r) => lc(r.name) === lc(performer)) ? performer : ''
	);
	function setPerformer(name: string) {
		if (!name) {
			roleOpen = false;
			return au.edit(step, { performer: null });
		}
		const r = roles.find((x) => x.name === name);
		if (r) au.edit(step, { performer: { name: r.name, code: r.code, color: r.color } });
	}

	function addCallout(kind: Callout['kind']) {
		const list = step.callouts ?? [];
		au.edit(step, { callouts: [...list, { kind, text: '' }] });
		focusWhenDrawn(`callout-${step.order}-${list.length}`);
	}

	function open(what: 'role' | 'duration') {
		if (what === 'role') roleOpen = true;
		else durationOpen = true;
		focusWhenDrawn(`${pid}-${what}`);
	}

	const stop = (e: KeyboardEvent) => e.stopPropagation();
</script>

<div class="grid grid-cols-1 gap-2" data-author-body={step.order}>
	{#if isOp || step.workcenter_id != null}
		<!-- What the OP needs before it runs. Which OPs it waits on, and whether its steps go in
		     order, are set in the Sequence tab. -->
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<label for={`${pid}-wc`} class="label">Workcenter</label>
			<NativeSelect
				id={`${pid}-wc`}
				class="w-48"
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
	{/if}

	<MarkdownEditor
		id={`instr-${step.order}`}
		label="Instructions"
		value={step.instructions}
		onchange={(v) => au.edit(step, { instructions: v })}
	>
		{#snippet badge()}<SaveBadge {step} />{/snippet}
		{#snippet between()}<CalloutsEditor {step} />{/snippet}
	</MarkdownEditor>

	<StepImages bind:this={images} images={step.images} {step} />
	{#if isOp}<UnitSlotsEditor bind:this={unitSlots} {step} />{/if}
	<KitEditor bind:this={kit} {step} />
	<CaptureFields bind:this={fields} {step} />
	<SignoffEditor bind:this={signoff} bind:opened={signoffOpen} {step} {op} />

	{#if hasRole || hasDuration}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
			{#if hasRole}
				<span class="flex items-center gap-2">
					<label for={`${pid}-role`} class="label">Role</label>
					<NativeSelect
						id={`${pid}-role`}
						class="w-48"
						value={roles.find((r) => lc(r.name) === lc(performer))?.name ?? performer}
						onkeydown={stop}
						onchange={(e) => setPerformer(e.currentTarget.value)}
					>
						<option value="">—</option>
						{#each roles as r (r.id)}<option value={r.name}>{r.code} {r.name}</option>{/each}
						{#if gone}<option value={gone} disabled>{gone} (no such role)</option>{/if}
					</NativeSelect>
				</span>
			{/if}
			{#if hasDuration}
				<span class="flex items-center gap-2">
					<label for={`${pid}-duration`} class="label">Duration (min)</label>
					<Input
						id={`${pid}-duration`}
						type="number"
						min="1"
						step="1"
						class="h-7 w-24 font-mono"
						value={step.estimated_duration_minutes ?? ''}
						onfocus={() => (durationOpen = true)}
						onkeydown={stop}
						oninput={(e) => {
							const v = e.currentTarget.value;
							au.edit(step, {
								estimated_duration_minutes: v === '' || Number(v) < 1 ? null : Math.round(Number(v))
							});
						}}
					/>
				</span>
			{/if}
		</div>
	{/if}

	<div>
		<KeyBank lead="ADD" label={`Add to ${isOp ? 'OP' : 'step'} ${step.number}`}>
			<BankKey title="A person can be hurt" onclick={() => addCallout('warning')}>WARNING</BankKey>
			<BankKey title="Hardware or the work can be damaged" onclick={() => addCallout('caution')}
				>CAUTION</BankKey
			>
			<BankKey onclick={() => addCallout('info')}>INFO</BankKey>
			{#if !head}
				<BankKey title="Reference images" onclick={() => images?.pick()}>IMAGE</BankKey>
				{#if !hasFields}
					<BankKey title="Values the operator records" onclick={() => fields?.addField()}
						>DATA</BankKey
					>
				{/if}
			{/if}
			<PartPicker exclude={taken} onselect={(p: PartHit | null) => kit?.open(p)}>
				{#snippet trigger({ props })}
					<BankKey {...props} title="Parts this step uses">STEP PARTS</BankKey>
				{/snippet}
			</PartPicker>
			{#if isOp && !(step.units ?? []).length}
				<PartPicker meta="tracking_type" onselect={(p: PartHit | null) => unitSlots?.add(p)}>
					{#snippet trigger({ props })}
						<BankKey {...props} title="Existing units this OP acts on">UNITS</BankKey>
					{/snippet}
				</PartPicker>
			{/if}
			{#if !signoffShown}
				<BankKey title="Who must sign" onclick={() => signoff?.open()}>SIGN-OFF</BankKey>
			{/if}
			{#if !hasRole}
				<BankKey title="Who does the work (shown, not enforced)" onclick={() => open('role')}
					>ROLE</BankKey
				>
			{/if}
			{#if !hasDuration}
				<BankKey title="Expected time, in minutes" onclick={() => open('duration')}
					>DURATION</BankKey
				>
			{/if}
		</KeyBank>
	</div>
</div>
