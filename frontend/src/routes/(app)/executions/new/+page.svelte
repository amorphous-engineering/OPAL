<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte';
	import {
		PageHeader,
		Section,
		State,
		toastError,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { DataTable, EmptyLine } from '#lib/components/opal/index.js';
	import FormRow from '#lib/components/executions/FormRow.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { fromInput, qty } from '#lib/format.js';
	import { EXECUTION_PRIORITIES, type CutPreview, type ExecutionPriority } from '@opal/shared';
	type PreviewPart = CutPreview['kit'][number];
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let procedureId = $state(data.preselect ? String(data.preselect) : '');
	// svelte-ignore state_referenced_locally
	let versionId = $state(data.preselectVersion ? String(data.preselectVersion) : '');
	let quantity = $state('1');
	let scheduled = $state('');
	let target = $state('');
	let priority = $state<ExecutionPriority>('normal');
	// svelte-ignore state_referenced_locally
	let projectId = $state(
		data.projectId || (data.procedures.find((p) => p.id === data.preselect)?.projectId ?? 0)
	);
	let projectTouched = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let preview = $state<CutPreview | null>(null);
	let previewError = $state<string | null>(null);

	const n = $derived(Math.min(100, Math.max(1, Math.floor(Number(quantity)) || 1)));

	// Context pre-fill: the preview follows procedure, version and quantity.
	$effect(() => {
		const proc = procedureId;
		const ver = versionId;
		const count = n;
		if (!proc) {
			preview = null;
			return;
		}
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				const p = await opal.execution.preview({
					procedureId: Number(proc),
					versionId: ver ? Number(ver) : undefined,
					quantity: count
				});
				if (cancelled) return;
				preview = p;
				previewError = null;
				if (!ver) versionId = String(p.versionId);
			} catch (e) {
				if (cancelled) return;
				preview = null;
				previewError = e instanceof Error ? e.message : 'Preview failed';
			}
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	function pickProcedure(value: string) {
		procedureId = value;
		const proc = data.procedures.find((p) => String(p.id) === value);
		// Context pre-fill: the project of the procedure, unless the person chose one.
		if (proc && !projectTouched) projectId = proc.projectId;
		versionId = '';
		preview = null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await opal.execution.create({
				procedureId: Number(procedureId),
				versionId: versionId ? Number(versionId) : undefined,
				projectId: projectId || undefined,
				quantity: n,
				scheduledStartAt: scheduled ? fromInput(scheduled) : undefined,
				targetCompletionAt: target ? fromInput(target) : undefined,
				priority
			});
			// One work order opens; a batch lands on the list of what was cut.
			await goto(n === 1 ? `/executions/${created.id}` : '/executions?status=cut');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to cut';
			toastError(err);
		} finally {
			busy = false;
		}
	}

	const partCols: Column<PreviewPart>[] = [
		{ key: 'part', label: 'PN', mono: true, width: '9rem' },
		{ key: 'partName', label: 'Name' },
		{ key: 'perWorkOrder', label: 'Per WO', align: 'right', mono: true, width: '6rem' },
		{ key: 'required', label: 'Required', align: 'right', mono: true, width: '6rem' },
		{ key: 'available', label: 'On hand', align: 'right', mono: true, width: '6rem' },
		{ key: 'isAvailable', label: 'Check', width: '6rem' }
	];
</script>

<PageHeader
	title="Cut work order"
	crumbs={[{ label: 'Executions', href: '/executions' }, { label: 'Cut' }]}
/>

<div class="grid grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[26rem_minmax(0,1fr)]">
	<Section title="Cut">
		<form class="grid grid-cols-1 gap-3 p-3" onsubmit={submit}>
			<FormRow label="Procedure" for="cut-procedure" required>
				<NativeSelect
					id="cut-procedure"
					class="w-full"
					required
					value={procedureId}
					onchange={(e) => pickProcedure(e.currentTarget.value)}
				>
					<option value="">Select procedure</option>
					{#each data.procedures as p (p.id)}<option value={String(p.id)}
							>{p.templateNumber} {p.name}</option
						>{/each}
				</NativeSelect>
			</FormRow>
			{#if !data.procedures.length}
				<p class="text-xs text-warn">No procedure has a published version.</p>
			{/if}
			<FormRow label="Project" for="cut-project" required>
				<div role="presentation" onchangecapture={() => (projectTouched = true)}>
					<ProjectSelect id="cut-project" bind:value={projectId} class="w-full" />
				</div>
			</FormRow>
			<div class="grid grid-cols-2 gap-3">
				<FormRow label="Version" for="cut-version">
					<NativeSelect
						id="cut-version"
						class="w-full"
						disabled={!preview}
						value={versionId}
						onchange={(e) => (versionId = e.currentTarget.value)}
					>
						{#if preview}
							{#each preview.versions as v (v.id)}
								<option value={String(v.id)}>v{v.number}{v.isCurrent ? ' (current)' : ''}</option>
							{/each}
						{:else}<option value="">—</option>{/if}
					</NativeSelect>
				</FormRow>
				<FormRow label="Quantity" for="cut-qty">
					<Input
						id="cut-qty"
						type="number"
						min="1"
						max="100"
						step="1"
						class="font-mono"
						bind:value={quantity}
						required
					/>
				</FormRow>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<FormRow label="Scheduled start" for="cut-sched">
					<Input id="cut-sched" type="datetime-local" class="font-mono" bind:value={scheduled} />
				</FormRow>
				<FormRow label="Target completion" for="cut-target">
					<Input id="cut-target" type="datetime-local" class="font-mono" bind:value={target} />
				</FormRow>
			</div>
			<FormRow label="Priority" for="cut-priority">
				<NativeSelect id="cut-priority" class="w-48" bind:value={priority}>
					{#each EXECUTION_PRIORITIES as p (p)}<option value={p}>{p.toUpperCase()}</option>{/each}
				</NativeSelect>
			</FormRow>
			{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
			<div class="flex gap-2">
				<Button type="submit" disabled={busy || !procedureId || !preview || !projectId}
					>{n === 1 ? 'CUT WORK ORDER' : `CUT ${n} WORK ORDERS`}</Button
				>
				<Button variant="outline" href="/executions">CANCEL</Button>
			</div>
		</form>
	</Section>

	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
		{#if previewError}
			<ErrorBanner message={previewError} />
		{:else if !preview}
			<EmptyLine label="Preview" empty="Nothing to preview." />
		{:else}
			<Section title="Procedure">
				<div class="flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-xs">
					<span class="font-mono text-muted-foreground">{preview.procedureNumber}</span>
					<span class="text-sm font-medium">{preview.procedureName}</span>
					<span class="font-mono">v{preview.versionNumber}</span>
					<span class="font-mono text-muted-foreground"
						>{preview.stepCount} STEPS ({preview.opCount} OP{preview.opCount === 1
							? ''
							: 'S'})</span
					>
					<State value={preview.procedureType} tone="muted" />
					{#if preview.kit.length || preview.stepKit.length}
						<State
							value="kit"
							tone={preview.allAvailable ? 'ok' : 'error'}
							label={preview.allAvailable ? 'KIT AVAILABLE' : 'KIT SHORT'}
							badge={!preview.allAvailable}
						/>
					{/if}
				</div>
			</Section>

			{#if preview.outputs.length}
				<Section title="Build outputs" count={preview.outputs.length * preview.quantity}>
					<table class="w-full border-collapse text-sm">
						<thead>
							<tr class="border-b border-border bg-muted/60 text-left">
								{#each ['PN', 'NAME', 'QTY EACH', 'SERIALS'] as h (h)}
									<th
										class="h-8 px-3 font-mono text-xs font-medium tracking-wider text-muted-foreground"
										>{h}</th
									>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each preview.outputs as o (o.partId)}
								<tr class="border-b border-border align-top">
									<td class="px-3 py-1.5 font-mono whitespace-nowrap">{o.partNumber}</td>
									<td class="px-3 py-1.5">{o.partName}</td>
									<td class="px-3 py-1.5 font-mono">{qty(o.quantityEach)}</td>
									<td class="px-3 py-1.5 font-mono">{o.serials.join(', ')}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</Section>
			{/if}

			{#each [{ title: 'Kit', rows: preview.kit }, { title: 'Step parts', rows: preview.stepKit }] as group (group.title)}
				{#if group.rows.length}
					<Section title={group.title} count={group.rows.length}>
						<DataTable
							rows={group.rows}
							columns={partCols}
							emptyLabel={group.title}
							key={(r) => `${r.partId}-${r.usage}`}
						>
							{#snippet cell(r, col)}
								{#if col.key === 'part'}
									<a class="text-info hover:underline" href={`/parts/${r.partId}`}>{r.partNumber}</a
									>
								{:else if col.key === 'partName'}
									{r.partName}{#if r.usage === 'tooling'}
										<State value="tooling" tone="info" class="ml-1.5" />{/if}
								{:else if col.key === 'isAvailable'}
									{#if r.isAvailable}
										<State value="ok" tone="ok" label="OK" />
									{:else}
										<State
											value="short"
											tone="error"
											label={`SHORT ${qty(Number(r.required) - Number(r.available))}`}
										/>
									{/if}
								{:else}
									{qty((r as unknown as Record<string, string>)[col.key])}
								{/if}
							{/snippet}
						</DataTable>
					</Section>
				{/if}
			{/each}
		{/if}
	</div>
</div>
