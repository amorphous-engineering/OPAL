<script lang="ts">
	// One disposition transition. Only the selected target's requirements are
	// shown. Values whose home is elsewhere on the page (residual score, linked
	// issues) appear as live status lines, never as duplicate inputs.
	import { invalidateAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { toast, toastError } from '#lib/components/opal/index.js';
	import { api } from '#lib/api.js';
	import EntityPicker from './EntityPicker.svelte';
	import { searchIssues } from './pickers.js';
	import type { Risk } from './types.js';

	interface Check {
		blockers: string[];
		open_mitigations: number;
		open_research: number;
		needs_note: boolean;
	}

	let { risk, target, ondone }: { risk: Risk; target: string; ondone: () => void } = $props();

	let check = $state<Check | null>(null);
	let note = $state('');
	// svelte-ignore state_referenced_locally
	let observable = $state(risk.watch_observable ?? '');
	// svelte-ignore state_referenced_locally
	let threshold = $state(risk.watch_threshold ?? '');
	// svelte-ignore state_referenced_locally
	let contingency = $state(risk.watch_contingency ?? '');
	let spawnTitle = $state('');
	let picked = $state<{ id: number; label: string } | null>(null);
	let busy = $state(false);

	// Re-check whenever the risk changes underneath the panel (links, residual).
	const fingerprint = $derived(
		JSON.stringify([
			target,
			risk.updated_at,
			risk.linked_issues,
			risk.realized_issue_id,
			risk.residual_probability,
			risk.residual_impact
		])
	);
	$effect(() => {
		void fingerprint;
		api
			.get<Check>(`/risks/${risk.id}/disposition-check`, { target })
			.then((c) => (check = c))
			.catch(toastError);
	});

	// Fields typed in this panel are saved with the transition, so the server's
	// view of them is stale: judge them locally.
	const blockers = $derived.by(() => {
		if (!check) return [];
		return check.blockers.filter((b) => {
			if (target === 'watch' && (b.includes('observable') || b.includes('threshold'))) return false;
			if (target === 'realized' && picked && b.includes('linked issue')) return false;
			return true;
		});
	});
	const missing = $derived.by(() => {
		const m: string[] = [];
		if (target === 'watch') {
			if (!observable.trim()) m.push('observable');
			if (!threshold.trim()) m.push('threshold');
		}
		if (check?.needs_note && !note.trim()) m.push('note');
		return m;
	});

	async function spawnRealized() {
		const title = spawnTitle.trim();
		if (!title) return;
		busy = true;
		try {
			await api.post(`/risks/${risk.id}/issues/spawn`, { role: 'realized', title });
			spawnTitle = '';
			await invalidateAll();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function apply() {
		busy = true;
		try {
			if (target === 'watch') {
				await api.patch(`/risks/${risk.id}`, {
					watch_observable: observable.trim() || null,
					watch_threshold: threshold.trim() || null,
					watch_contingency: contingency.trim() || null
				});
			}
			await api.post(`/risks/${risk.id}/disposition`, {
				disposition: target,
				note: note.trim() || null,
				realized_issue_id: picked?.id ?? null
			});
			toast.success(`${risk.risk_number} is now ${target.toUpperCase()}`);
			await invalidateAll();
			ondone();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="grid grid-cols-1 gap-3 border-t border-border bg-muted/30 p-3">
	<h3 class="label text-foreground">Set {target}</h3>

	{#if target === 'mitigate'}
		<p class="font-mono text-xs">
			Open mitigation issues
			<span class={check && check.open_mitigations ? 'text-ok' : 'text-error'}
				>{check?.open_mitigations ?? '—'}</span
			>
			· Residual score
			{#if risk.residual_score !== null}<span class="text-ok">{risk.residual_score}</span
				>{:else}<span class="text-error">not set</span>{/if}
		</p>
	{:else if target === 'research'}
		<p class="font-mono text-xs">
			Open research issues
			<span class={check && check.open_research ? 'text-ok' : 'text-muted-foreground'}
				>{check?.open_research ?? '—'}</span
			>
			· Narrative
			<span class={risk.description ? 'text-ok' : 'text-muted-foreground'}
				>{risk.description ? 'present' : 'empty'}</span
			>
		</p>
	{:else if target === 'watch'}
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="watch-observable">Observable</Label>
				<Input id="watch-observable" class="font-mono" bind:value={observable} maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="watch-threshold">Threshold</Label>
				<Input id="watch-threshold" class="font-mono" bind:value={threshold} maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5 sm:col-span-2">
				<Label for="watch-contingency">Contingency <span class="label">optional</span></Label>
				<Input id="watch-contingency" class="font-mono" bind:value={contingency} />
			</div>
		</div>
	{:else if target === 'realized'}
		{#if risk.realized_issue_number}
			<p class="font-mono text-xs">
				Realized issue <a class="text-ok hover:underline" href={`/issues/${risk.realized_issue_id}`}
					>{risk.realized_issue_number}</a
				>
			</p>
		{:else if picked}
			<p class="font-mono text-xs">
				Realized issue <span class="text-ok">{picked.label}</span>
				<button
					type="button"
					class="label ml-2 hover:text-foreground"
					onclick={() => (picked = null)}>CLEAR</button
				>
			</p>
		{:else}
			<p class="font-mono text-xs">Realized issue <span class="text-error">none</span></p>
			<div class="flex flex-wrap items-center gap-2">
				<Input
					class="w-72"
					aria-label="New issue title"
					placeholder="What happened"
					bind:value={spawnTitle}
					maxlength={255}
					onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), spawnRealized())}
				/>
				<Button
					variant="outline"
					size="sm"
					onclick={spawnRealized}
					disabled={busy || !spawnTitle.trim()}>SPAWN ISSUE</Button
				>
				<span class="label">or</span>
				<EntityPicker
					label="PICK ISSUE"
					placeholder="Search issues"
					search={searchIssues}
					onpick={(o) => (picked = { id: o.value, label: o.label })}
				/>
			</div>
		{/if}
	{/if}

	{#if check?.needs_note}
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="disposition-note"
				>{risk.disposition === 'accepted' && target !== 'closed'
					? 'Un-accept note'
					: 'Close note'}</Label
			>
			<Input
				id="disposition-note"
				class="font-mono"
				bind:value={note}
				maxlength={255}
				onkeydown={(e) => e.key === 'Enter' && !blockers.length && !missing.length && apply()}
			/>
		</div>
	{/if}

	{#if blockers.length}
		<ul class="grid grid-cols-1 gap-0.5 font-mono text-xs text-error">
			{#each blockers as b (b)}<li>{b}</li>{/each}
		</ul>
	{/if}

	<div class="flex items-center gap-2">
		<Button
			size="sm"
			onclick={apply}
			disabled={busy || !check || blockers.length > 0 || missing.length > 0}
			>SET {target.toUpperCase()}</Button
		>
		<Button size="sm" variant="outline" onclick={ondone}>CANCEL</Button>
		{#if missing.length}
			<span class="font-mono text-xs text-muted-foreground">needs {missing.join(', ')}</span>
		{/if}
	</div>
</div>
