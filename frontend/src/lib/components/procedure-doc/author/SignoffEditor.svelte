<script lang="ts">
	// The sign-off table in authoring: the same shape as the execution table
	// (label | role | signature | action). The label is the row's position (Primary
	// buyoff, then Secondary buyoff) and the role (the gate) is the only input. Primary stays while
	// any other row exists; a leaf step always keeps it, an OP with sub-steps may
	// drop it once it is alone. Saves go through the authoring store.
	import { EmptyLine, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
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
	/** The server sets labels by position too; this keeps the local copy in step. */
	const slotLabel = (i: number) => (i === 0 ? 'Primary buyoff' : 'Secondary buyoff');
	const relabel = (list: SignoffDef[]) => list.map((r, i) => ({ ...r, label: slotLabel(i) }));
	const setRole = (i: number, role: string | null) =>
		save(relabel(rows.map((r, n) => (n === i ? { ...r, role } : r))));
	const remove = (i: number) => save(relabel(rows.filter((_, n) => n !== i)));
	const add = () => save(relabel([...rows, { label: '', role: null }]));
	const removable = (i: number) => i > 0 || (mayBeEmpty && rows.length === 1);
</script>

<div data-signoff-editor={step.order} data-op={op.order}>
	{#if rows.length === 0}
		<EmptyLine label="Sign-offs" onadd={add} addLabel="+ SIGN-OFF" />
	{:else}
		<div class="overflow-hidden rounded-lg border border-border">
			<table class="w-full font-mono text-xs" aria-label="Sign-offs">
				<tbody>
					{#each rows as s, i (i)}
						<tr class="border-b border-border last:border-b-0" data-slot={i}>
							<td class="w-28 px-3 py-1 font-sans text-sm font-medium">{slotLabel(i)}</td>
							<td class="w-36 px-2 py-1">
								<NativeSelect
									aria-label={`${slotLabel(i)} sign-off role`}
									size="sm"
									class="w-full"
									value={known.find((n) => n.toLowerCase() === s.role?.toLowerCase()) ??
										s.role ??
										''}
									onkeydown={(e) => e.stopPropagation()}
									onchange={(e) => setRole(i, e.currentTarget.value || null)}
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
									aria-label={`Remove ${slotLabel(i)} sign-off`}
									disabled={!removable(i)}
									onclick={() => remove(i)}>X</Button
								>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<button
			type="button"
			class="mt-1 font-mono text-xs font-medium text-info hover:underline"
			onclick={add}>+ SIGN-OFF</button
		>
	{/if}
</div>
