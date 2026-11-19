<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		Field,
		FormKeys,
		NextNumber,
		needs,
		PageHeader,
		Section,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte'; // added by projects
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { partLabel } from '#lib/components/parts/types.js';
	import LintField from '#lib/components/risks/LintField.svelte';
	import Score from '#lib/components/risks/Score.svelte';
	import { IMPACT, PROBABILITY, severityOf } from '#lib/components/risks/types.js';
	import { opal } from '#lib/api.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let projectId = $state(data.projectId); // added by projects
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

	const missing = $derived(needs({ project: projectId, title: title.trim() }));
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
			const risk = await opal.risks.create({
				projectId, // added by projects
				title: title.trim(),
				condition: condition.trim() || null,
				departure: departure.trim() || null,
				assetPartId: asset?.id ?? null,
				assetText: asset ? null : assetText.trim() || null,
				consequence: consequence.trim() || null,
				ownerId: ownerId ? Number(ownerId) : null,
				probability: Number(probability),
				impact: Number(impact),
				residualProbability: residualProbability ? Number(residualProbability) : null,
				residualImpact: residualImpact ? Number(residualImpact) : null,
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

<form class="grid max-w-3xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="Risk">
		<div class="grid grid-cols-1 gap-3 p-3">
			<NextNumber kind="risk" />
			<Field label="Project" for="project" required>
				<ProjectSelect id="project" bind:value={projectId} />
			</Field>

			<Field label="Title" for="title" required>
				<Input id="title" bind:value={title} maxlength={255} required autofocus />
			</Field>

			<!-- The hints are the risk statement's grammar: each part is scored by a different
			     number, so they stay beside the boxes. -->
			<Field label="Condition" for="condition" hint="A present fact, true now.">
				<LintField
					id="condition"
					field="condition"
					bind:value={condition}
					onkeydown={submitOnCtrlEnter}
				/>
			</Field>

			<Field
				label="Departure"
				for="departure"
				hint="The future undesired event. Probability scores this."
			>
				<LintField
					id="departure"
					field="departure"
					bind:value={departure}
					onkeydown={submitOnCtrlEnter}
				/>
			</Field>

			<Field label="Asset" for="asset-text" hint="What is exposed: a part, or a name.">
				<div class="flex flex-wrap items-center gap-2">
					{#if asset}
						<a class="font-mono text-xs text-info hover:underline" href={`/parts/${asset.id}`}
							>{asset.label}</a
						>
						<Button size="sm" variant="outline" onclick={() => (asset = null)}>CLEAR</Button>
					{:else}
						<PartPicker
							trigger={pickPart}
							onselect={(p) => {
								if (!p) return;
								asset = { id: p.id, label: partLabel(p) };
								assetText = '';
							}}
						/>
						<span class="text-xs text-muted-foreground">or</span>
						<Input id="asset-text" class="w-72" bind:value={assetText} maxlength={255} />
					{/if}
				</div>
			</Field>

			<Field
				label="Consequence"
				for="consequence"
				hint="The measurable impact. Impact scores this."
			>
				<LintField
					id="consequence"
					field="consequence"
					bind:value={consequence}
					onkeydown={submitOnCtrlEnter}
				/>
			</Field>

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<Field label="Owner" for="owner">
					<NativeSelect id="owner" class="w-full" bind:value={ownerId}>
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each data.owners as o (o.id)}<NativeSelectOption value={String(o.id)}
								>{o.name}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</Field>
				<Field label="Probability" for="probability">
					<NativeSelect id="probability" class="w-full" bind:value={probability}>
						{#each PROBABILITY as p (p.value)}<NativeSelectOption value={String(p.value)}
								>{p.label}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</Field>
				<Field label="Impact" for="impact">
					<NativeSelect id="impact" class="w-full" bind:value={impact}>
						{#each IMPACT as p (p.value)}<NativeSelectOption value={String(p.value)}
								>{p.label}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</Field>
			</div>

			<div class="flex flex-wrap items-end gap-3">
				<Field label="Residual probability" for="res-p">
					<NativeSelect id="res-p" bind:value={residualProbability}>
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
								>{v}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</Field>
				<Field label="Residual impact" for="res-i">
					<NativeSelect id="res-i" bind:value={residualImpact}>
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
								>{v}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</Field>
				<div class="ml-auto grid grid-cols-1 gap-1.5 text-right">
					<span class="label">Score</span>
					<Score
						class="text-lg font-semibold"
						{score}
						severity={severityOf(score)}
						{residual}
						residualSeverity={residual === null ? null : severityOf(residual)}
					/>
				</div>
			</div>

			<Field label="Narrative" for="description">
				<MarkdownField
					id="description"
					bind:value={description}
					minRows={4}
					onsubmit={() =>
						document.querySelector<HTMLFormElement>('form:has(#description)')?.requestSubmit()}
				/>
			</Field>
		</div>
	</Section>
	<FormKeys submit="CREATE" cancel="/risks" {missing} {busy} {error} />
</form>

{#snippet pickPart({ props }: { props: Record<string, unknown> })}
	<Button {...props} variant="outline" size="sm">PICK PART</Button>
{/snippet}
