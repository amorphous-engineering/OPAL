<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader } from '#lib/components/opal/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import EntityPicker from '#lib/components/risks/EntityPicker.svelte';
	import LintField from '#lib/components/risks/LintField.svelte';
	import Score from '#lib/components/risks/Score.svelte';
	import { searchParts } from '#lib/components/risks/pickers.js';
	import { IMPACT, PROBABILITY, severityOf, type Risk } from '#lib/components/risks/types.js';
	import { api } from '#lib/api.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let title = $state('');
	let condition = $state('');
	let departure = $state('');
	let consequence = $state('');
	// svelte-ignore state_referenced_locally
	let asset = $state(data.asset);
	let assetText = $state('');
	let ownerId = $state('');
	let probability = $state('3');
	let impact = $state('3');
	let residualProbability = $state('');
	let residualImpact = $state('');
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const score = $derived(Number(probability) * Number(impact));
	const residual = $derived(
		residualProbability && residualImpact
			? Number(residualProbability) * Number(residualImpact)
			: null
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const risk = await api.post<Risk>('/risks', {
				title: title.trim(),
				condition: condition.trim() || null,
				departure: departure.trim() || null,
				asset_part_id: asset?.id ?? null,
				asset_text: asset ? null : assetText.trim() || null,
				consequence: consequence.trim() || null,
				owner_id: ownerId ? Number(ownerId) : null,
				probability: Number(probability),
				impact: Number(impact),
				residual_probability: residualProbability ? Number(residualProbability) : null,
				residual_impact: residualImpact ? Number(residualImpact) : null,
				description: description.trim() || null
			});
			await goto(`/risks/${risk.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create the risk';
			toastError(err);
		} finally {
			busy = false;
		}
	}

	function submitOnCtrlEnter(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			(e.currentTarget as HTMLElement).closest('form')?.requestSubmit();
		}
	}
</script>

<PageHeader title="New risk" crumbs={[{ label: 'Risks', href: '/risks' }, { label: 'New' }]} />

<form class="grid max-w-3xl gap-4 p-4" onsubmit={submit}>
	{#if error}
		<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
			{error}
		</p>
	{/if}

	<div class="grid gap-1.5">
		<Label for="title">Title</Label>
		<Input id="title" bind:value={title} maxlength={255} required autofocus />
	</div>

	<div class="grid gap-1.5">
		<Label for="condition">Condition <span class="label">present fact, true now</span></Label>
		<LintField
			id="condition"
			field="condition"
			bind:value={condition}
			onkeydown={submitOnCtrlEnter}
		/>
	</div>

	<div class="grid gap-1.5">
		<Label for="departure"
			>Departure <span class="label">future undesired event; probability scores this</span></Label
		>
		<LintField
			id="departure"
			field="departure"
			bind:value={departure}
			onkeydown={submitOnCtrlEnter}
		/>
	</div>

	<div class="grid gap-1.5">
		<Label for="asset-text"
			>Asset <span class="label">what is exposed: a part, or a name</span></Label
		>
		<div class="flex flex-wrap items-center gap-2">
			{#if asset}
				<span class="font-mono text-xs"
					><a class="text-info hover:underline" href={`/parts/${asset.id}`}>{asset.label}</a></span
				>
				<Button variant="ghost" size="xs" onclick={() => (asset = null)}>CLEAR</Button>
			{:else}
				<EntityPicker
					label="PICK PART"
					placeholder="Search parts"
					search={searchParts}
					onpick={(o) => {
						asset = { id: o.value, label: `${o.label} ${o.sub ?? ''}`.trim() };
						assetText = '';
					}}
				/>
				<span class="label">or</span>
				<Input
					id="asset-text"
					class="w-72"
					bind:value={assetText}
					maxlength={255}
					placeholder="schedule, test campaign"
				/>
			{/if}
		</div>
	</div>

	<div class="grid gap-1.5">
		<Label for="consequence"
			>Consequence <span class="label">measurable impact; impact scores this</span></Label
		>
		<LintField
			id="consequence"
			field="consequence"
			bind:value={consequence}
			onkeydown={submitOnCtrlEnter}
		/>
	</div>

	<div class="grid gap-3 sm:grid-cols-3">
		<div class="grid content-start gap-1.5">
			<Label for="owner">Owner</Label>
			<NativeSelect id="owner" class="w-full" bind:value={ownerId}>
				<NativeSelectOption value="">—</NativeSelectOption>
				{#each data.owners as o (o.id)}<NativeSelectOption value={String(o.id)}
						>{o.name}</NativeSelectOption
					>{/each}
			</NativeSelect>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for="probability">Probability</Label>
			<NativeSelect id="probability" class="w-full" bind:value={probability}>
				{#each PROBABILITY as p (p.value)}<NativeSelectOption value={String(p.value)}
						>{p.label}</NativeSelectOption
					>{/each}
			</NativeSelect>
		</div>
		<div class="grid content-start gap-1.5">
			<Label for="impact">Impact</Label>
			<NativeSelect id="impact" class="w-full" bind:value={impact}>
				{#each IMPACT as p (p.value)}<NativeSelectOption value={String(p.value)}
						>{p.label}</NativeSelectOption
					>{/each}
			</NativeSelect>
		</div>
	</div>

	<div class="flex flex-wrap items-end gap-3">
		<div class="grid gap-1.5">
			<Label for="res-p">Residual probability</Label>
			<NativeSelect id="res-p" bind:value={residualProbability}>
				<NativeSelectOption value="">—</NativeSelectOption>
				{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
						>{v}</NativeSelectOption
					>{/each}
			</NativeSelect>
		</div>
		<div class="grid gap-1.5">
			<Label for="res-i">Residual impact</Label>
			<NativeSelect id="res-i" bind:value={residualImpact}>
				<NativeSelectOption value="">—</NativeSelectOption>
				{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
						>{v}</NativeSelectOption
					>{/each}
			</NativeSelect>
		</div>
		<div class="ml-auto grid gap-1.5 text-right">
			<span class="label">Score</span>
			<Score
				class="text-2xl font-semibold"
				{score}
				severity={severityOf(score)}
				{residual}
				residualSeverity={residual === null ? null : severityOf(residual)}
			/>
		</div>
	</div>

	<div class="grid gap-1.5">
		<Label for="description">Narrative <span class="label">context, evidence, markdown</span></Label
		>
		<Textarea id="description" bind:value={description} rows={4} onkeydown={submitOnCtrlEnter} />
	</div>

	<div class="flex gap-2">
		<Button type="submit" disabled={busy || !title.trim()}>CREATE</Button>
		<Button variant="outline" href="/risks">CANCEL</Button>
	</div>
</form>
