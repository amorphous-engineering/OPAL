<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { PageHeader, Section, toastError, ErrorBanner } from '#lib/components/opal/index.js';
	import { api, ApiError } from '#lib/api.js';
	import LintEditor from '#lib/components/requirements/LintEditor.svelte';
	import { VERIFICATION_METHODS } from '#lib/components/requirements/lifecycle.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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

	const parent = $derived(data.parents.find((p) => String(p.id) === parentId) ?? null);
	const categories = $derived([...new Set(data.parents.map((p) => p.category).filter(Boolean))]);

	// A child inherits its parent's category until one is typed.
	let categoryTouched = false;
	$effect(() => {
		if (!categoryTouched && parent?.category) category = parent.category;
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await api.post<{ id: number }>('/requirements', {
				title,
				statement,
				rationale: rationale || null,
				category: category || null,
				verification_method: method || null,
				parent_id: parentId ? Number(parentId) : null,
				tbd,
				tbr,
				tbr_owner_id: tbr && owner ? Number(owner) : null,
				tbr_due: tbr && due ? `${due}T00:00:00Z` : null
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

<form class="max-w-3xl p-4" onsubmit={submit}>
	<Section title="DRAFT">
		<div class="grid grid-cols-1 gap-4 p-4">
			<ErrorBanner message={error} />
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="title">Title</Label>
				<Input
					id="title"
					bind:value={title}
					maxlength={255}
					required
					placeholder="Short name, e.g. Chamber pressure"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="statement">Shall statement</Label>
				<LintEditor
					id="statement"
					bind:value={statement}
					required
					placeholder="The <subject> shall <one thought>, e.g. The engine shall sustain a chamber pressure of 20 bar ± 1 bar."
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="rationale">Rationale</Label>
				<Textarea
					id="rationale"
					bind:value={rationale}
					rows={2}
					placeholder="Where the number came from and what it protects. Required before baseline."
				/>
			</div>
			<div class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="parent">Parent</Label>
					<NativeSelect id="parent" bind:value={parentId} class="w-full">
						<NativeSelectOption value="">None (level 0)</NativeSelectOption>
						{#each data.parents as p (p.id)}
							<NativeSelectOption value={String(p.id)}
								>{p.req_number} L{p.level} {p.title}</NativeSelectOption
							>
						{/each}
					</NativeSelect>
					<p class="font-mono text-xs text-muted-foreground">
						Level {parent ? parent.level + 1 : 0}
					</p>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="method">Verification method</Label>
					<NativeSelect id="method" bind:value={method} class="w-full">
						<NativeSelectOption value="">Not set</NativeSelectOption>
						{#each VERIFICATION_METHODS as m (m)}
							<NativeSelectOption value={m}>{m.toUpperCase()}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="category">Category</Label>
					<Input
						id="category"
						bind:value={category}
						maxlength={50}
						list="req-categories"
						oninput={() => (categoryTouched = true)}
						placeholder="functional, performance, interface"
					/>
					<datalist id="req-categories">
						{#each categories as c (c)}<option value={c!}></option>{/each}
					</datalist>
				</div>
			</div>
			<div class="flex flex-wrap gap-x-6 gap-y-2">
				<label class="flex items-center gap-2 text-xs">
					<Checkbox bind:checked={tbd} /> <span class="mono">TBD</span>
					<span class="text-muted-foreground">value not yet determined</span>
				</label>
				<label class="flex items-center gap-2 text-xs">
					<Checkbox bind:checked={tbr} /> <span class="mono">TBR</span>
					<span class="text-muted-foreground">value to be reviewed</span>
				</label>
			</div>
			{#if tbr}
				<div class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="owner">TBR owner</Label>
						<NativeSelect id="owner" bind:value={owner} class="w-full">
							<NativeSelectOption value="">Not set</NativeSelectOption>
							{#each data.assignees as u (u.id)}
								<NativeSelectOption value={String(u.id)}>{u.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="due">TBR due</Label>
						<Input id="due" type="date" bind:value={due} class="w-44 font-mono" />
					</div>
				</div>
			{/if}
		</div>
		<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
			<Button variant="outline" href="/requirements">CANCEL</Button>
			<Button type="submit" disabled={busy || !title.trim() || !statement.trim()}
				>CREATE DRAFT</Button
			>
		</div>
	</Section>
</form>
