<script lang="ts">
	// Sign-offs in authoring. A leaf step always stores one slot; alone and without a role it is the
	// routine tick (anyone completes the step, CLAUDE.md rule 8), and this draws nothing. The table
	// shows once the step is not routine (the first slot names a role, or a second slot exists), or
	// when the author opens it from ADD. An OP with sub-steps has no slot until one is added.
	// Labels follow the position: Sign-off, then Second sign-off. Stored labels are set by the
	// server from the position too; this only changes what the author reads.
	import { BankKey, KeyBank, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { offeredIn, roleList } from '#lib/components/users/roles.js';
	import { useDoc } from '../controller.js';
	import type { DocOp, DocStep, SignoffDef } from '../types.js';
	import { focusWhenDrawn } from './focus.js';

	let {
		step,
		op,
		opened = $bindable(false)
	}: { step: DocStep; op: DocOp; opened?: boolean } = $props();
	const au = useDoc().author!;

	const rows = $derived(step.signoff_defs ?? []);
	/** An OP with sub-steps: it may have no slot at all. */
	const head = $derived(op.step === step && op.steps.length > 0);
	const routine = $derived(head ? rows.length === 0 : rows.length <= 1 && !rows[0]?.role);
	const shown = $derived(opened || !routine);
	/** What the table draws: a leaf opened from ADD shows its routine slot, ready for a role. */
	const drawn = $derived(rows.length ? rows : head ? [] : [{ label: '', role: null }]);

	let known = $state<string[]>([]);
	$effect(() => {
		roleList()
			.then((r) => (known = offeredIn(r, au.projectId).map((x) => x.name)))
			.catch(toastError);
	});
	/** Roles to offer, plus the row's own role when it no longer exists. */
	const optionsFor = (role: string | null) =>
		role && !known.some((n) => n.toLowerCase() === role.toLowerCase()) ? [role] : [];

	const slotLabel = (i: number) => (i === 0 ? 'Primary buyoff' : 'Secondary buyoff');
	const shownLabel = (i: number) => (i === 0 ? 'Sign-off' : 'Second sign-off');
	const relabel = (list: SignoffDef[]) => list.map((r, i) => ({ ...r, label: slotLabel(i) }));
	const save = (next: SignoffDef[]) => au.edit(step, { signoffs: relabel(next) });

	const setRole = (i: number, role: string | null) =>
		save(drawn.map((r, n) => (n === i ? { ...r, role } : r)));
	/** ADD SIGN-OFF: an OP with sub-steps gets its first slot; a step shows its slot for a role. */
	export function open() {
		opened = true;
		if (head && !rows.length) save([{ label: '', role: null }]);
		focusWhenDrawn(`signoff-${step.order}-0`);
	}
	const addSecond = () => save([...drawn, { label: '', role: null }]);
	function remove(i: number) {
		if (i > 0) return save(drawn.filter((_, n) => n !== i));
		// The second becomes the only sign-off; it keeps its role.
		if (drawn.length > 1) return save(drawn.slice(1));
		// Removing the sign-off returns the step to routine: a leaf keeps its roleless slot.
		opened = false;
		save(head ? [] : [{ label: '', role: null }]);
	}
</script>

{#if shown}
	<div class="grid grid-cols-1 gap-1.5" data-signoff-editor={step.order} data-op={op.order}>
		{#each drawn as s, i (i)}
			<div class="flex flex-wrap items-center gap-2" data-slot={i}>
				<span class="label w-36">{shownLabel(i)}</span>
				<NativeSelect
					id={`signoff-${step.order}-${i}`}
					aria-label={`${shownLabel(i)} role`}
					class="w-44"
					value={known.find((n) => n.toLowerCase() === s.role?.toLowerCase()) ?? s.role ?? ''}
					onkeydown={(e) => e.stopPropagation()}
					onchange={(e) => setRole(i, e.currentTarget.value || null)}
				>
					<NativeSelectOption value="">Any role</NativeSelectOption>
					{#each known as n (n)}
						<NativeSelectOption value={n}>{n}</NativeSelectOption>
					{/each}
					{#each optionsFor(s.role) as n (n)}
						<NativeSelectOption value={n}>{n} (no such role)</NativeSelectOption>
					{/each}
				</NativeSelect>
				<KeyBank label={`${shownLabel(i)} tools`}>
					<BankKey aria-label={`Remove ${shownLabel(i).toLowerCase()}`} onclick={() => remove(i)}
						>REMOVE</BankKey
					>
				</KeyBank>
			</div>
		{/each}
		{#if drawn.length === 1}
			<div>
				<Button size="sm" variant="outline" onclick={addSecond}>+ SECOND SIGN-OFF</Button>
			</div>
		{/if}
	</div>
{/if}
