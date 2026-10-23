<script lang="ts">
	// Issues that respond to (mitigation) or investigate (research) a risk.
	import { invalidateAll } from '$app/navigation';
	import {
		DataTable,
		EmptyLine,
		Section,
		State,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import EntityPicker from './EntityPicker.svelte';
	import { searchIssues } from './pickers.js';
	import type { LinkedIssue, Risk } from './types.js';

	let { risk }: { risk: Risk } = $props();

	const ROLES = ['mitigation', 'research'];
	let adding = $state(false);
	let role = $state('mitigation');
	let title = $state('');
	let busy = $state(false);

	const columns: Column<LinkedIssue>[] = [
		{ key: 'issue_number', label: 'Issue', mono: true, width: '8rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'role', label: 'Role', width: '8rem' },
		{ key: 'status', label: 'Status', width: '8rem' },
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

	/** Issues already on the risk cannot be linked twice. */
	async function searchUnlinked(q: string) {
		const linked = new Set(risk.linked_issues.map((l) => l.issue_id));
		return (await searchIssues(q)).filter((o) => !linked.has(o.value));
	}

	const link = (issueId: number, number: string) =>
		run(
			() => api.post(`/risks/${risk.id}/issues`, { issue_id: issueId, role }),
			`${number} linked as ${role}`
		);

	async function spawn() {
		const t = title.trim();
		if (!t) return;
		await run(
			() => api.post(`/risks/${risk.id}/issues/spawn`, { role, title: t }),
			'Issue created and linked'
		);
		title = '';
	}

	const unlink = (l: LinkedIssue) =>
		run(() => api.del(`/risks/${risk.id}/issues/${l.issue_id}`), `${l.issue_number} unlinked`);
</script>

{#snippet form()}
	<div class="flex flex-wrap items-center gap-2 border-t border-border p-3">
		<NativeSelect aria-label="Role" bind:value={role}>
			{#each ROLES as r (r)}<NativeSelectOption value={r}>{r.toUpperCase()}</NativeSelectOption
				>{/each}
		</NativeSelect>
		<EntityPicker
			label="LINK ISSUE"
			placeholder="Search issues"
			search={searchUnlinked}
			disabled={busy}
			onpick={(o) => link(o.value, o.label)}
		/>
		<span class="label">or</span>
		<Input
			class="w-64"
			aria-label="New issue title"
			placeholder="New issue title"
			bind:value={title}
			maxlength={255}
			onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), spawn())}
		/>
		<Button variant="outline" size="sm" onclick={spawn} disabled={busy || !title.trim()}
			>SPAWN ISSUE</Button
		>
	</div>
{/snippet}

{#if risk.linked_issues.length}
	<Section title="Linked issues" count={risk.linked_issues.length}>
		{#snippet actions()}
			<Button variant="ghost" size="xs" onclick={() => (adding = !adding)}
				>{adding ? 'DONE' : '+ ADD'}</Button
			>
		{/snippet}
		<DataTable
			rows={risk.linked_issues}
			{columns}
			href={(l) => `/issues/${l.issue_id}`}
			key={(l) => l.issue_id}
			emptyLabel="Linked issues"
		>
			{#snippet cell(l, col)}
				{#if col.key === 'issue_number'}
					<span class="text-info">{l.issue_number}</span>
				{:else if col.key === 'title'}
					{l.title}
				{:else if col.key === 'role'}
					<span class="font-mono text-xs">{l.role.toUpperCase()}</span>
				{:else if col.key === 'status'}
					<State value={l.status} />
				{:else}
					<Button variant="ghost" size="xs" disabled={busy} onclick={() => unlink(l)}>UNLINK</Button
					>
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render form()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine
			label="Linked issues"
			onadd={() => (adding = !adding)}
			addLabel={adding ? 'DONE' : '+ ADD'}
		/>
		{#if adding}<div class="rounded-b-lg border border-t-0 border-border bg-card">
				{@render form()}
			</div>{/if}
	</div>
{/if}
