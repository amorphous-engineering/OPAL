<script lang="ts">
	// The sign-off table in authoring: the same shape as the execution table
	// (label | role | signature | action), with label and role as inputs, a remove
	// X per row, and + SIGN-OFF. A leaf step keeps at least one row; an OP with
	// sub-steps may have none. Saves go through the authoring store.
	import { EmptyLine, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { roleNames } from '#lib/components/users/roles.js';
	import { useDoc } from '../controller.js';
	import type { DocOp, DocStep, SignoffDef } from '../types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const au = useDoc().author!;

	const rows = $derived(step.signoff_defs ?? []);
	const mayBeEmpty = $derived(op.step === step && op.steps.length > 0);
	let known = $state<string[]>([]);
	$effect(() => {
		roleNames()
			.then((n) => (known = n))
			.catch(toastError);
	});
	/** Roles to offer, plus the row's own role when it no longer exists. */
	const optionsFor = (role: string | null) =>
		role && !known.some((n) => n.toLowerCase() === role.toLowerCase()) ? [role] : [];

	const save = (next: SignoffDef[]) => au.edit(step, { signoffs: next });
	const patch = (i: number, p: Partial<SignoffDef>) =>
		save(rows.map((r, n) => (n === i ? { ...r, ...p } : r)));
	const remove = (i: number) => save(rows.filter((_, n) => n !== i));
	function add() {
		const n = rows.length;
		const label = mayBeEmpty
			? n
				? `Sign-off ${n + 1}`
				: 'Sign-off'
			: n === 1
				? 'Secondary buyoff'
				: `Sign-off ${n + 1}`;
		save([...rows, { label, role: null }]);
	}
	const locked = $derived(!mayBeEmpty && rows.length <= 1);
</script>

<div data-signoff-editor={step.order} data-op={op.order}>
	{#if rows.length === 0}
		<EmptyLine label="Sign-offs" onadd={add} addLabel="+ SIGN-OFF" />
	{:else}
		<table class="w-full border border-border font-mono text-xs" aria-label="Sign-offs">
			<tbody>
				{#each rows as s, i (i)}
					<tr class="border-b border-border last:border-b-0" data-slot={i}>
						<td class="w-44 px-2 py-1">
							<Input
								aria-label={`Sign-off ${i + 1} label`}
								maxlength={100}
								class="h-7 font-sans text-sm font-medium"
								value={s.label}
								onkeydown={(e) => e.stopPropagation()}
								oninput={(e) => patch(i, { label: e.currentTarget.value })}
							/>
						</td>
						<td class="w-36 px-2 py-1">
							<NativeSelect
								aria-label={`Sign-off ${i + 1} role`}
								size="sm"
								class="w-full"
								value={known.find((n) => n.toLowerCase() === s.role?.toLowerCase()) ?? s.role ?? ''}
								onkeydown={(e) => e.stopPropagation()}
								onchange={(e) => patch(i, { role: e.currentTarget.value || null })}
							>
								<NativeSelectOption value="">—</NativeSelectOption>
								{#each known as n (n)}
									<NativeSelectOption value={n}>{n}</NativeSelectOption>
								{/each}
								{#each optionsFor(s.role) as n (n)}
									<NativeSelectOption value={n}>{n} (no such role)</NativeSelectOption>
								{/each}
							</NativeSelect>
						</td>
						<td class="px-3 py-1 text-muted-foreground">–</td>
						<td class="w-20 px-2 py-1 text-right">
							<Button
								type="button"
								size="xs"
								variant="outline"
								aria-label={`Remove sign-off ${i + 1}`}
								title={locked ? 'A step keeps at least one sign-off' : 'Remove sign-off'}
								disabled={locked}
								onclick={() => remove(i)}>X</Button
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<button
			type="button"
			class="mt-1 font-mono text-xs font-medium text-info hover:underline"
			onclick={add}>+ SIGN-OFF</button
		>
	{/if}
</div>
