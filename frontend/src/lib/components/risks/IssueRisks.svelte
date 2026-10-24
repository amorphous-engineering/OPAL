<script lang="ts">
	// The risks an issue responds to (mitigation, research) or realizes. Linking and
	// unlinking go through the risks area; a realized pointer is set on the risk itself.
	import { opal } from '#lib/api.js';
	import { EmptyLine, Section, toast, toastError } from '#lib/components/opal/index.js';
	import EntityPicker, { type PickerOption } from '#lib/components/opal/EntityPicker.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { stateLabel } from '#lib/format.js';
	import { RISK_ISSUE_ROLES, type IssueDetail, type RiskIssueRole } from '@opal/shared';

	let {
		issue,
		refresh,
		readonly = false
	}: { issue: IssueDetail; refresh: () => Promise<unknown>; readonly?: boolean } = $props();

	let adding = $state(false);
	let role = $state<RiskIssueRole>('mitigation');
	let busy = $state(false);

	async function searchRisks(q: string): Promise<PickerOption[]> {
		const linked = new Set(issue.risks.map((r) => r.riskId));
		const r = await opal.risks.list({ q, limit: 20, sort: 'score', dir: 'desc' });
		return r.items
			.filter((x) => !linked.has(x.id))
			.map((x) => ({ value: x.id, label: x.riskNumber, sub: x.title }));
	}

	async function run(action: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await action();
			toast.success(done);
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	const link = (o: PickerOption) =>
		run(
			() => opal.risks.linkIssue({ id: o.value, issueId: issue.id, role }),
			`${o.label} linked as ${role}`
		);
	const unlink = (riskId: number, riskNumber: string) =>
		run(
			() => opal.risks.unlinkIssue({ id: riskId, issueId: issue.id }),
			`${riskNumber} unlinked`
		);
</script>

{#snippet form()}
	<div class="flex flex-wrap items-center gap-2 border-t border-border p-3">
		<NativeSelect aria-label="Role" bind:value={role}>
			{#each RISK_ISSUE_ROLES as r (r)}<NativeSelectOption value={r}
					>{r.toUpperCase()}</NativeSelectOption
				>{/each}
		</NativeSelect>
		<EntityPicker
			label="LINK RISK"
			placeholder="Search risks"
			search={searchRisks}
			disabled={busy}
			onpick={link}
		/>
	</div>
{/snippet}

{#if issue.risks.length}
	<Section title="Risks" count={issue.risks.length}>
		{#snippet actions()}
			{#if !readonly}
				<Button variant="ghost" size="xs" onclick={() => (adding = !adding)}
					>{adding ? 'DONE' : '+ ADD'}</Button
				>
			{/if}
		{/snippet}
		<ul class="divide-y divide-border">
			{#each issue.risks as r (r.riskId + r.relation)}
				<li class="flex items-baseline gap-2 px-3 py-1.5 text-sm">
					<a href={`/risks/${r.riskId}`} class="font-mono text-info hover:underline"
						>{r.riskNumber}</a
					>
					<span class="truncate">{r.title}</span>
					<span class="ml-auto font-mono text-xs tracking-wider text-muted-foreground uppercase"
						>{stateLabel(r.relation)}</span
					>
					{#if !readonly && r.relation !== 'realized'}
						<button
							type="button"
							class="font-mono text-xs tracking-wider text-info uppercase hover:underline"
							disabled={busy}
							onclick={() => unlink(r.riskId, r.riskNumber)}>UNLINK</button
						>
					{/if}
				</li>
			{/each}
		</ul>
		{#if adding && !readonly}{@render form()}{/if}
	</Section>
{:else if readonly}
	<EmptyLine label="Risks" />
{:else}
	<div>
		<EmptyLine
			label="Risks"
			onadd={() => (adding = !adding)}
			addLabel={adding ? 'DONE' : '+ ADD'}
		/>
		{#if adding}<div class="rounded-b-lg border border-t-0 border-border bg-card">
				{@render form()}
			</div>{/if}
	</div>
{/if}
