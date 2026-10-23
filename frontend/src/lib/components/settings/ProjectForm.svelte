<script lang="ts">
	// Project configuration: create (first run) or edit. One form, one save.
	import { refreshAll } from '$app/navigation';
	import {
		confirm,
		DataTable,
		Section,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { api, ApiError } from '#lib/api.js';
	import type { ProjectConfig } from './types.js';

	let { existing }: { existing: ProjectConfig | null } = $props();

	interface TierRow {
		/** Stable identity for keyed rendering. */
		id: number;
		/** Part rows reference tiers by level, so an existing level never changes. */
		level: number;
		name: string;
		code: string;
		description: string;
		tracking: 'serialized' | 'bulk';
		requireLot: boolean;
		autoSerial: boolean;
	}
	interface FieldRow {
		id: number;
		key: string;
		value: string;
	}

	let nextId = 0;
	const DEFAULT_TIERS = [
		['Flight', 'F', 'serialized', true, true],
		['Ground', 'G', 'serialized', true, false],
		['Loose', 'L', 'bulk', false, false]
	] as const;

	// svelte-ignore state_referenced_locally
	const seed = existing;
	let name = $state(seed?.name ?? '');
	let description = $state(seed?.description ?? '');
	let tiers = $state<TierRow[]>(
		seed
			? seed.tiers.map((t) => ({
					id: nextId++,
					level: t.level,
					name: t.name,
					code: t.code,
					description: t.description,
					tracking: t.default_tracking ?? 'bulk',
					requireLot: !!t.require_lot,
					autoSerial: !!t.auto_serial
				}))
			: DEFAULT_TIERS.map(([n, c, tr, lot, ser], i) => ({
					id: nextId++,
					level: i + 1,
					name: n,
					code: c,
					description: '',
					tracking: tr,
					requireLot: lot,
					autoSerial: ser
				}))
	);
	let prefix = $state(seed?.part_numbering.prefix ?? '');
	let separator = $state(seed?.part_numbering.separator ?? '-');
	let digits = $state(String(seed?.part_numbering.sequence_digits ?? 4));
	let format = $state(seed?.part_numbering.format ?? '{prefix}{sep}{tier_code}{sep}{sequence}');
	let categories = $state<string[]>(seed ? [...seed.categories] : []);
	let categoryDraft = $state('');
	let fields = $state<FieldRow[]>(
		Object.entries(seed?.custom_fields ?? {}).map(([key, value]) => ({
			id: nextId++,
			key,
			value: typeof value === 'string' ? value : JSON.stringify(value)
		}))
	);
	// Non-string custom field values survive an edit untouched.
	const originalFields = seed?.custom_fields ?? {};

	let busy = $state(false);
	let error = $state<string | null>(null);

	function addTier() {
		const level = Math.max(0, ...tiers.map((t) => t.level)) + 1;
		tiers.push({
			id: nextId++,
			level,
			name: '',
			code: '',
			description: '',
			tracking: 'bulk',
			requireLot: false,
			autoSerial: false
		});
	}

	function addCategory() {
		const value = categoryDraft.trim();
		if (value && !categories.includes(value)) categories.push(value);
		categoryDraft = '';
	}

	function addField() {
		fields.push({ id: nextId++, key: '', value: '' });
	}

	// Live preview: what the format renders for each tier, as the server would.
	function render(t: TierRow, sequence: number): string {
		const vars: Record<string, string> = {
			prefix,
			sep: separator,
			tier_code: t.code || '?',
			tier_name: t.name || '?',
			tier_level: String(t.level),
			sequence: String(sequence).padStart(parseInt(digits, 10) || 4, '0')
		};
		return format.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
	}
	const formatProblem = $derived.by(() => {
		const unknown = [...format.matchAll(/\{(\w*)\}/g)]
			.map((m) => m[1])
			.filter(
				(k) => !['prefix', 'sep', 'tier_code', 'tier_name', 'tier_level', 'sequence'].includes(k)
			);
		if (unknown.length) return `Unknown variable {${unknown[0]}}`;
		if (!format.includes('{sequence')) return 'The format needs {sequence}';
		return null;
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (formatProblem) {
			error = formatProblem;
			return;
		}
		const custom: Record<string, unknown> = {};
		for (const f of fields) {
			const key = f.key.trim();
			if (!key) continue;
			custom[key] =
				key in originalFields && JSON.stringify(originalFields[key]) === f.value
					? originalFields[key]
					: f.value;
		}
		const body = {
			name,
			description,
			tiers: tiers.map((t) => ({
				level: t.level,
				name: t.name,
				code: t.code.toUpperCase(),
				description: t.description,
				default_tracking: t.tracking,
				require_lot: t.requireLot,
				auto_serial: t.autoSerial
			})),
			part_numbering: {
				prefix,
				separator,
				sequence_digits: parseInt(digits, 10),
				format
			},
			categories,
			custom_fields: custom
		};
		busy = true;
		try {
			if (existing) {
				await api.put('/project/config', body);
				toast.success('Project saved');
				await refreshAll();
			} else {
				await api.post('/project/config', body);
				// Creating the project is the last step of first-run onboarding.
				await api.post('/welcome/complete').catch(() => {});
				toast.success('Project created');
				window.location.assign('/');
			}
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save the project';
		} finally {
			busy = false;
		}
	}

	async function removeTier(t: TierRow) {
		if (existing?.tiers.some((x) => x.level === t.level)) {
			const ok = await confirm({
				title: `Remove tier ${t.name || t.level}?`,
				body: 'Saving is refused while parts still use this tier.',
				action: 'REMOVE',
				destructive: true
			});
			if (!ok) return;
		}
		tiers = tiers.filter((x) => x.id !== t.id);
	}

	async function importCatalog() {
		try {
			const r = await api.post<{ created: string[]; skipped: string[]; relinked: number }>(
				'/project/requirements/import'
			);
			toast.success(
				`Imported ${r.created.length} requirement(s), ${r.skipped.length} already present`
			);
		} catch (err) {
			toastError(err);
		}
	}

	const previewColumns: Column<TierRow>[] = [
		{ key: 'level', label: 'Tier' },
		{ key: 'first', label: 'First', mono: true },
		{ key: 'tenth', label: 'Tenth', mono: true }
	];
	const catalog = $derived(existing?.requirements ?? []);
</script>

<form class="grid grid-cols-1 gap-4" onsubmit={save}>
	<div class="grid min-w-0 grid-cols-1 gap-4">
		{#if error}
			<p
				role="alert"
				class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
			>
				{error}
			</p>
		{/if}

		<Section title="General">
			<div class="grid grid-cols-1 gap-3 p-3">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="p-name">Name</Label>
					<Input id="p-name" bind:value={name} required autocomplete="off" />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="p-desc">Description</Label>
					<Textarea id="p-desc" bind:value={description} rows={2} />
				</div>
			</div>
		</Section>

		<Section title="Inventory tiers" count={tiers.length}>
			{#snippet actions()}
				<Button variant="ghost" size="xs" onclick={addTier}>+ ADD TIER</Button>
			{/snippet}
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-sm">
					<thead>
						<tr class="border-b border-border bg-muted/60">
							{#each ['Level', 'Name', 'Code', 'Description', 'Tracking', 'Lot required', 'Auto serial', ''] as h (h)}
								<th
									class="h-8 px-2 text-left font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
									>{h}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each tiers as t (t.id)}
							<tr class="border-b border-border align-middle">
								<td class="px-2 py-1 font-mono tabular-nums">{t.level}</td>
								<td class="px-2 py-1"
									><Input
										bind:value={t.name}
										aria-label="Tier name"
										class="h-7 min-w-24"
										required
									/></td
								>
								<td class="px-2 py-1"
									><Input
										bind:value={t.code}
										aria-label="Tier code"
										class="h-7 w-16 font-mono uppercase"
										maxlength={8}
										required
									/></td
								>
								<td class="px-2 py-1"
									><Input
										bind:value={t.description}
										aria-label="Tier description"
										class="h-7"
									/></td
								>
								<td class="px-2 py-1">
									<NativeSelect.Root
										size="sm"
										class="w-32"
										aria-label="Default tracking"
										bind:value={t.tracking}
									>
										<NativeSelect.Option value="serialized">Serialized</NativeSelect.Option>
										<NativeSelect.Option value="bulk">Bulk</NativeSelect.Option>
									</NativeSelect.Root>
								</td>
								<td class="px-2 py-1"
									><Switch size="sm" aria-label="Lot required" bind:checked={t.requireLot} /></td
								>
								<td class="px-2 py-1"
									><Switch size="sm" aria-label="Auto serial" bind:checked={t.autoSerial} /></td
								>
								<td class="px-2 py-1 text-right">
									<Button
										variant="ghost"
										size="xs"
										class="text-destructive"
										disabled={tiers.length <= 1}
										onclick={() => removeTier(t)}>REMOVE</Button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Section>

		<Section title="Categories" count={categories.length}>
			<div class="grid grid-cols-1 gap-2 p-3">
				{#if categories.length}
					<div class="flex flex-wrap gap-1">
						{#each categories as c (c)}
							<span
								class="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted pr-0.5 pl-2 font-mono text-xs"
							>
								{c}
								<button
									type="button"
									class="px-1 text-muted-foreground hover:text-destructive"
									aria-label={`Remove ${c}`}
									onclick={() => (categories = categories.filter((x) => x !== c))}>x</button
								>
							</span>
						{/each}
					</div>
				{/if}
				<div class="flex gap-2">
					<Input
						bind:value={categoryDraft}
						class="h-7 max-w-64"
						aria-label="New category"
						placeholder="Category name"
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addCategory();
							}
						}}
					/>
					<Button variant="outline" size="sm" onclick={addCategory} disabled={!categoryDraft.trim()}
						>ADD</Button
					>
				</div>
			</div>
		</Section>

		<Section title="Custom fields" count={fields.length}>
			{#snippet actions()}
				<Button variant="ghost" size="xs" onclick={addField}>+ ADD FIELD</Button>
			{/snippet}
			{#if fields.length}
				<div class="grid grid-cols-1 gap-2 p-3">
					{#each fields as f (f.id)}
						<div class="flex gap-2">
							<Input
								bind:value={f.key}
								class="h-7 w-48 font-mono"
								aria-label="Field name"
								placeholder="Name"
							/>
							<Input
								bind:value={f.value}
								class="h-7 flex-1"
								aria-label="Field value"
								placeholder="Value"
							/>
							<Button
								variant="ghost"
								size="xs"
								class="text-destructive"
								onclick={() => (fields = fields.filter((x) => x.id !== f.id))}>REMOVE</Button
							>
						</div>
					{/each}
				</div>
			{/if}
		</Section>
		<Section title="Part numbering">
			<div class="grid grid-cols-1 gap-3 p-3">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="pn-prefix">Prefix</Label>
						<Input id="pn-prefix" class="font-mono" bind:value={prefix} placeholder="e.g. RV1" />
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="pn-sep">Separator</Label>
						<NativeSelect.Root id="pn-sep" bind:value={separator} class="w-full">
							<NativeSelect.Option value="-">- dash</NativeSelect.Option>
							<NativeSelect.Option value="_">_ underscore</NativeSelect.Option>
							<NativeSelect.Option value=".">. dot</NativeSelect.Option>
							<NativeSelect.Option value="">none</NativeSelect.Option>
						</NativeSelect.Root>
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="pn-digits">Sequence digits</Label>
						<NativeSelect.Root id="pn-digits" bind:value={digits} class="w-full">
							{#each [3, 4, 5, 6] as d (d)}
								<NativeSelect.Option value={String(d)}>{d}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="pn-format">Format</Label>
					<Input
						id="pn-format"
						class="font-mono"
						bind:value={format}
						aria-invalid={formatProblem ? true : undefined}
					/>
					<span class="font-mono text-xs text-muted-foreground"
						>{'{prefix} {sep} {tier_code} {tier_name} {tier_level} {sequence}'}</span
					>
					{#if formatProblem}<span class="text-xs text-error">{formatProblem}</span>{/if}
				</div>
			</div>
			<DataTable rows={tiers} columns={previewColumns} key={(t) => t.id} emptyLabel="PREVIEW" dense>
				{#snippet cell(t, col)}
					{#if col.key === 'level'}
						{t.name || '—'} <span class="font-mono text-xs text-muted-foreground">L{t.level}</span>
					{:else if formatProblem}
						<span class="text-muted-foreground">—</span>
					{:else}
						<span class="text-info">{render(t, col.key === 'first' ? 1 : 10)}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Section>

		{#if catalog.length}
			<Section title="Requirement catalog" count={catalog.length}>
				{#snippet actions()}
					<Button variant="ghost" size="xs" onclick={importCatalog}>IMPORT</Button>
				{/snippet}
				<DataTable
					rows={catalog}
					columns={[
						{ key: 'id', label: 'Number', mono: true },
						{ key: 'title', label: 'Title' },
						{ key: 'category', label: 'Category' }
					]}
					key={(r) => r.id}
					emptyLabel="REQUIREMENTS"
					dense
				/>
			</Section>
		{/if}

		<div class="flex gap-2">
			<Button type="submit" class="flex-1" disabled={busy || !name.trim()}
				>{existing ? 'SAVE PROJECT' : 'CREATE PROJECT'}</Button
			>
			{#if !existing}<Button variant="outline" href="/">CANCEL</Button>{/if}
		</div>
	</div>
</form>
