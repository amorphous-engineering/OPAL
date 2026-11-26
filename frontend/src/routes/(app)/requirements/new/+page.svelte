<script lang="ts">
	import { goto } from '$app/navigation';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import {
		Field,
		FormKeys,
		NextNumber,
		needs,
		PageHeader,
		Section,
		toastError
	} from '#lib/components/opal/index.js';
	import { opal, ApiError } from '#lib/api.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte'; // added by projects
	import LintEditor from '#lib/components/requirements/LintEditor.svelte';
	import { VERIFICATION_METHODS } from '#lib/components/requirements/lifecycle.js';
	import type { RequirementVerificationMethod as VerificationMethod } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let projectId = $state(data.projectId); // added by projects
	let title = $state('');
	let statement = $state('');
	let rationale = $state('');
	let category = $state('');
	let method = $state('');
	// svelte-ignore state_referenced_locally
	let parentId = $state(String(data.parentId ?? ''));
	let tbd = $state(false);
	let tbr = $state(false);
	let owner = $state('');
	let due = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// added by projects: flow-down stays inside one project
	const candidates = $derived(data.parents.filter((p) => p.projectId === projectId));
	const parent = $derived(candidates.find((p) => String(p.id) === parentId) ?? null);
	const categories = $derived([...new Set(candidates.map((p) => p.category).filter(Boolean))]);
	$effect(() => {
		if (parentId && !parent) parentId = '';
	});

	// A child inherits its parent's category until one is typed.
	let categoryTouched = false;
	$effect(() => {
		if (!categoryTouched && parent?.category) category = parent.category;
	});

	const missing = $derived(
		needs({ project: projectId, title: title.trim(), 'shall statement': statement.trim() })
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await opal.requirements.create({
				projectId, // added by projects
				title,
				statement,
				rationale: rationale || null,
				category: category || null,
				verificationMethod: (method || null) as VerificationMethod | null,
				parentId: parentId ? Number(parentId) : null,
				tbd,
				tbr,
				tbrOwnerId: tbr && owner ? Number(owner) : null,
				tbrDue: tbr && due ? `${due}T00:00:00Z` : null
			});
			await goto(`/requirements/${created.id}`);
		} catch (err) {
			if (err instanceof ApiError) error = err.message;
			else toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New requirement"
	crumbs={[{ label: 'Requirements', href: '/requirements' }, { label: 'New' }]}
/>

<form class="grid max-w-3xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="Requirement">
		<div class="grid grid-cols-1 gap-3 p-3">
			<NextNumber kind="requirement" />
			<Field label="Project" for="project" required>
				<ProjectSelect id="project" bind:value={projectId} />
			</Field>
			<Field label="Title" for="title" required>
				<Input id="title" bind:value={title} maxlength={255} required autofocus />
			</Field>
			<Field
				label="Shall statement"
				for="statement"
				required
				hint="The <subject> shall <one thought>."
			>
				<LintEditor id="statement" bind:value={statement} required />
			</Field>
			<Field
				label="Rationale"
				for="rationale"
				hint="Where the number came from and what it protects."
			>
				<Textarea id="rationale" bind:value={rationale} rows={2} />
			</Field>
			<div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
				<Field label="Parent" for="parent" hint={parent ? `Level ${parent.level + 1}` : null}>
					<NativeSelect id="parent" bind:value={parentId} class="w-full">
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each candidates as p (p.id)}
							<NativeSelectOption value={String(p.id)}
								>{p.reqNumber} L{p.level} {p.title}</NativeSelectOption
							>
						{/each}
					</NativeSelect>
				</Field>
				<Field label="Verification method" for="method">
					<NativeSelect id="method" bind:value={method} class="w-full">
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each VERIFICATION_METHODS as m (m)}
							<NativeSelectOption value={m}>{m.toUpperCase()}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</Field>
				<Field label="Category" for="category">
					<Input
						id="category"
						bind:value={category}
						maxlength={50}
						list="req-categories"
						oninput={() => (categoryTouched = true)}
					/>
					<datalist id="req-categories">
						{#each categories as c (c)}<option value={c!}></option>{/each}
					</datalist>
				</Field>
			</div>
			<div class="flex flex-wrap gap-x-6 gap-y-2">
				<label class="flex items-center gap-2 text-xs" title="To be determined">
					<Checkbox bind:checked={tbd} /> <span class="mono">TBD</span>
				</label>
				<label class="flex items-center gap-2 text-xs" title="To be reviewed">
					<Checkbox bind:checked={tbr} /> <span class="mono">TBR</span>
				</label>
			</div>
			{#if tbr}
				<div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
					<Field label="TBR owner" for="owner">
						<NativeSelect id="owner" bind:value={owner} class="w-full">
							<NativeSelectOption value="">—</NativeSelectOption>
							{#each data.assignees as u (u.id)}
								<NativeSelectOption value={String(u.id)}>{u.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</Field>
					<Field label="TBR due" for="due">
						<Input id="due" type="date" bind:value={due} class="w-44 font-mono" />
					</Field>
				</div>
			{/if}
		</div>
	</Section>
	<FormKeys submit="CREATE" cancel="/requirements" {missing} {busy} {error} />
</form>
