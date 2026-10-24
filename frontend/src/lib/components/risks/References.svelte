<script lang="ts">
	// OPAL numbers and work orders the risk refers to.
	import { invalidateAll } from '$app/navigation';
	import {
		DataTable,
		EmptyLine,
		Section,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import { RISK_REFERENCE_TYPES, type Risk, type RiskReference } from '@opal/shared';

	let { risk }: { risk: Risk } = $props();

	let adding = $state(false);
	let type = $state<(typeof RISK_REFERENCE_TYPES)[number]>('opal');
	let value = $state('');
	let notes = $state('');
	let busy = $state(false);

	const columns: Column<RiskReference>[] = [
		{ key: 'type', label: 'Type', width: '8rem' },
		{ key: 'value', label: 'Number', mono: true, width: '10rem' },
		{ key: 'notes', label: 'Notes' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];

	async function run(action: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await action();
			toast.success(done);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function add() {
		const v = value.trim();
		if (!v) return;
		await run(
			() => opal.risks.addReference({ id: risk.id, type, value: v, notes: notes.trim() || null }),
			`${v.toUpperCase()} referenced`
		);
		value = '';
		notes = '';
	}
</script>

{#snippet form()}
	<div class="flex flex-wrap items-center gap-2 border-t border-border p-3">
		<NativeSelect aria-label="Reference type" bind:value={type}>
			<NativeSelectOption value="opal">OPAL</NativeSelectOption>
			<NativeSelectOption value="work_order">WORK ORDER</NativeSelectOption>
		</NativeSelect>
		<Input
			class="w-40 font-mono"
			aria-label="Number"
			placeholder={type === 'opal' ? 'OPAL-00042' : 'WO-00015'}
			bind:value
			maxlength={20}
			onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
		/>
		<Input class="w-64" aria-label="Notes" placeholder="Notes" bind:value={notes} />
		<Button variant="outline" size="sm" onclick={add} disabled={busy || !value.trim()}>ADD</Button>
	</div>
{/snippet}

{#if risk.references.length}
	<Section title="References" count={risk.references.length}>
		{#snippet actions()}
			<Button variant="ghost" size="xs" onclick={() => (adding = !adding)}
				>{adding ? 'DONE' : '+ ADD'}</Button
			>
		{/snippet}
		<DataTable
			rows={risk.references}
			{columns}
			key={(r) => r.id}
			emptyLabel="References"
		>
			{#snippet cell(r, col)}
				{#if col.key === 'type'}
					<span class="font-mono text-xs">{r.type === 'opal' ? 'OPAL' : 'WORK ORDER'}</span>
				{:else if col.key === 'value'}
					{r.value}
				{:else if col.key === 'notes'}
					{#if r.notes}{r.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<Button
						variant="ghost"
						size="xs"
						disabled={busy}
						onclick={() =>
							run(
								() => opal.risks.removeReference({ id: risk.id, referenceId: r.id }),
								`${r.value} removed`
							)}>REMOVE</Button
					>
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render form()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine
			label="References"
			onadd={() => (adding = !adding)}
			addLabel={adding ? 'DONE' : '+ ADD'}
		/>
		{#if adding}<div class="rounded-b-lg border border-t-0 border-border bg-card">
				{@render form()}
			</div>{/if}
	</div>
{/if}
