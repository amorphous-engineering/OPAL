<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import {
		confirm,
		DataTable,
		DetailRow,
		DetailTable,
		ErrorBanner,
		PageHeader,
		Section,
		State,
		Timestamp,
		toast
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { opal } from '#lib/api.js';
	import PermissionList from '#lib/components/plugins/PermissionList.svelte';
	import PreviewDialog from '#lib/components/plugins/PreviewDialog.svelte';
	import ProjectMapField from '#lib/components/plugins/ProjectMapField.svelte';
	import {
		PROCESS_TONES,
		pluginError,
		pluginOptions,
		sourceLabel
	} from '#lib/components/plugins/state.js';
	import type { PluginDetail, PluginOptions, PluginPreview, PluginSettingDef } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Polled copy of the plugin; a new navigation resets it.
	let plugin = $derived<PluginDetail>(data.plugin);
	const m = $derived(plugin.manifest);
	const proc = $derived(plugin.process);

	let error = $state<string | null>(null);
	let busy = $state(false);

	// Refresh while the page is open. Settings stay as typed.
	$effect(() => {
		const id = plugin.id;
		const t = setInterval(async () => {
			try {
				plugin = await opal.plugins.get({ id });
			} catch {
				/* the next tick tries again */
			}
		}, 3000);
		return () => clearInterval(t);
	});

	async function act(fn: () => Promise<PluginDetail>, done?: string) {
		busy = true;
		error = null;
		try {
			plugin = await fn();
			if (done) toast.success(done);
		} catch (e) {
			error = pluginError(e);
		} finally {
			busy = false;
		}
	}

	// ---- settings form
	type Draft = string | boolean | Record<string, string>;
	function seed(p: PluginDetail): Record<string, Draft> {
		const out: Record<string, Draft> = {};
		for (const d of p.manifest.settings) {
			const cur = p.settings.find((s) => s.key === d.key);
			const v = cur?.value ?? d.default ?? null;
			if (d.type === 'project-map') {
				const obj = typeof v === 'string' ? safeJson(v) : v;
				out[d.key] = obj && typeof obj === 'object' ? { ...(obj as Record<string, string>) } : {};
				continue;
			}
			out[d.key] =
				d.type === 'secret'
					? ''
					: d.type === 'boolean'
						? v === true || v === 'true'
						: d.type === 'json'
							? v == null
								? ''
								: typeof v === 'string'
									? v
									: JSON.stringify(v, null, 2)
							: v == null
								? ''
								: String(v);
		}
		return out;
	}
	function safeJson(t: string): unknown {
		try {
			return JSON.parse(t);
		} catch {
			return null;
		}
	}
	let draft = $state<Record<string, Draft>>(untrack(() => seed(data.plugin)));

	// Values the running plugin offers (`optionsFrom`). Loaded again when it starts.
	// One request per path, tried again while it fails: a plugin that just started
	// can be slow, or rate-limited by the service it calls.
	let options = $state<Record<string, PluginOptions['items'] | null>>({});
	const running = $derived(proc.state === 'running');
	$effect(() => {
		const on = running;
		const id = plugin.id;
		const byPath: Record<string, string[]> = {};
		for (const d of untrack(() => m.settings))
			if (d.optionsFrom) (byPath[d.optionsFrom] ??= []).push(d.key);
		if (!on) {
			for (const keys of Object.values(byPath)) for (const k of keys) options[k] = null;
			return;
		}
		let stopped = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const [path, keys] of Object.entries(byPath)) {
			const load = async (attempt: number) => {
				const o = await pluginOptions(id, path);
				if (stopped) return;
				for (const k of keys) options[k] = o;
				if (!o && attempt < 6)
					timers.push(setTimeout(() => load(attempt + 1), 2000 * 2 ** attempt));
			};
			void load(0);
		}
		return () => {
			stopped = true;
			timers.forEach(clearTimeout);
		};
	});
	let formError = $state<string | null>(null);
	let saving = $state(false);
	const isSet = (key: string) => plugin.settings.find((s) => s.key === key)?.set ?? false;

	async function save(e: SubmitEvent) {
		e.preventDefault();
		formError = null;
		const values: Record<string, unknown> = {};
		for (const d of m.settings as PluginSettingDef[]) {
			const v = draft[d.key];
			if (d.type === 'secret') {
				if (v !== '') values[d.key] = v;
			} else if (d.type === 'boolean') values[d.key] = v;
			else if (d.type === 'project-map') values[d.key] = v;
			else if (d.type === 'number') values[d.key] = v === '' ? null : Number(v);
			else if (d.type === 'json') {
				if (v === '') values[d.key] = null;
				else
					try {
						values[d.key] = JSON.parse(v as string);
					} catch {
						formError = `${d.label}: not valid JSON`;
						return;
					}
			} else values[d.key] = v === '' ? null : v;
		}
		saving = true;
		try {
			plugin = await opal.plugins.settings({ id: plugin.id, values });
			draft = seed(plugin);
			toast.success('Settings saved');
		} catch (err) {
			formError = pluginError(err, 'Could not save');
		} finally {
			saving = false;
		}
	}

	// ---- update and remove
	let preview = $state<PluginPreview | null>(null);
	let previewOpen = $state(false);

	async function update() {
		busy = true;
		error = null;
		try {
			preview = await opal.plugins.preview({ source: sourceLabel(plugin) });
			previewOpen = true;
		} catch (e) {
			error = pluginError(e, 'Could not read the plugin');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const ok = await confirm({
			title: `Remove ${plugin.name}?`,
			body: 'The plugin stops. Its token, files, settings and links are deleted. Its user stays, deactivated.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		busy = true;
		error = null;
		try {
			await opal.plugins.remove({ id: plugin.id });
			toast.success(`${plugin.name} removed`);
			await goto('/settings#plugins', { invalidateAll: true });
		} catch (e) {
			error = pluginError(e, 'Could not remove');
			busy = false;
		}
	}

	// ---- log: follow the end
	let logEl = $state<HTMLElement>();
	$effect(() => {
		void plugin.log.length;
		const el = logEl;
		if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
	});
</script>

<PageHeader
	title={plugin.name}
	crumbs={[
		{ label: 'System' },
		{ label: 'Settings', href: '/settings' },
		{ label: 'Plugins', href: '/settings#plugins' },
		{ label: plugin.name }
	]}
>
	{#snippet state()}
		<span class="inline-flex items-center gap-1.5">
			<span class="font-mono text-xs text-muted-foreground">{plugin.version}</span>
			<State
				value={plugin.enabled ? 'enabled' : 'disabled'}
				badge
				tone={plugin.enabled ? 'ok' : 'muted'}
			/>
			{#if plugin.enabled}<State
					value={proc.state}
					badge
					tone={PROCESS_TONES[proc.state] ?? 'muted'}
				/>{/if}
		</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={update} disabled={busy}>UPDATE</Button>
		<Button variant="outline" size="sm" onclick={remove} disabled={busy}>REMOVE</Button>
	{/snippet}
</PageHeader>

<div class="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 p-4">
	<ErrorBanner message={error} />

	<Section title="Details">
		<DetailTable>
			<DetailRow label="Id" value={plugin.id} mono />
			<DetailRow label="Summary" value={m.summary} />
			<DetailRow label="Homepage">
				{#if m.homepage}<a
						href={m.homepage}
						target="_blank"
						rel="noreferrer"
						class="font-mono text-info hover:underline">{m.homepage}</a
					>{/if}
			</DetailRow>
			<DetailRow label="Source" value={plugin.source} mono />
			<DetailRow label="Ref" value={plugin.ref} mono />
			<DetailRow label="SHA" value={plugin.sha} mono />
			{#if plugin.previousSha}<DetailRow
					label="Previous SHA"
					value={plugin.previousSha}
					mono
				/>{/if}
			<DetailRow label="OPAL" value={m.opal} mono />
			<DetailRow label="User" value={plugin.username} mono />
			<DetailRow label="Installed"><Timestamp value={plugin.installedAt} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={plugin.updatedAt} /></DetailRow>
		</DetailTable>
	</Section>

	<Section title="Permissions">
		<PermissionList now={m.permissions} />
	</Section>

	<Section title="Settings" count={m.settings.length}>
		{#if m.settings.length === 0}
			<div class="px-3 py-2 text-sm text-muted-foreground">No settings.</div>
		{:else}
			<form class="grid grid-cols-1 gap-3 p-3" onsubmit={save}>
				<ErrorBanner message={formError} />
				{#each m.settings as d (d.key)}
					<div class="grid grid-cols-1 gap-1.5">
						{#if d.type === 'boolean'}
							<div class="flex items-center gap-2">
								<Switch id="s-{d.key}" bind:checked={draft[d.key] as boolean} />
								<Label for="s-{d.key}">{d.label}</Label>
							</div>
						{:else}
							<Label for="s-{d.key}" class="flex items-center gap-2">
								{d.label}
								{#if d.required}<span class="font-mono text-xs text-muted-foreground">REQUIRED</span
									>{/if}
								{#if d.type === 'secret'}<State
										value={isSet(d.key) ? 'set' : 'not_set'}
										badge
										tone={isSet(d.key) ? 'ok' : 'warn'}
										label={isSet(d.key) ? 'SET' : 'NOT SET'}
									/>{/if}
							</Label>
							{#if d.type === 'project-map'}
								<ProjectMapField
									id="s-{d.key}"
									bind:value={draft[d.key] as Record<string, string>}
									options={options[d.key] ?? null}
								/>
							{:else if d.type === 'select' && d.optionsFrom && !options[d.key]}
								<Input
									id="s-{d.key}"
									class="font-mono"
									autocomplete="off"
									bind:value={draft[d.key] as string}
								/>
							{:else if d.type === 'select'}
								{@const opts = d.optionsFrom
									? (options[d.key] ?? [])
									: (d.options ?? []).map((o) => ({ value: o, label: o }))}
								<NativeSelect id="s-{d.key}" bind:value={draft[d.key] as string}>
									{#if !d.required}<NativeSelectOption value="">—</NativeSelectOption>{/if}
									{#each opts as o (o.value)}
										<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>
									{/each}
								</NativeSelect>
							{:else if d.type === 'json'}
								<Textarea
									id="s-{d.key}"
									class="font-mono text-xs"
									rows={5}
									bind:value={draft[d.key] as string}
								/>
							{:else if d.type === 'secret'}
								<Input
									id="s-{d.key}"
									class="font-mono"
									type="password"
									autocomplete="new-password"
									bind:value={draft[d.key] as string}
									placeholder={isSet(d.key) ? 'Stored. Blank keeps it.' : ''}
								/>
							{:else}
								<Input
									id="s-{d.key}"
									class="font-mono"
									type={d.type === 'number' ? 'number' : d.type === 'url' ? 'url' : 'text'}
									step={d.type === 'number' ? 'any' : undefined}
									autocomplete="off"
									bind:value={draft[d.key] as string}
								/>
							{/if}
						{/if}
					</div>
				{/each}
				<div><Button type="submit" size="sm" disabled={saving}>SAVE</Button></div>
			</form>
		{/if}
	</Section>

	<Section title="Process">
		{#snippet actions()}
			{#if plugin.enabled}
				<Button
					variant="ghost"
					size="xs"
					disabled={busy}
					onclick={() => act(() => opal.plugins.restart({ id: plugin.id }))}>RESTART</Button
				>
				<Button
					variant="ghost"
					size="xs"
					disabled={busy}
					onclick={() => act(() => opal.plugins.disable({ id: plugin.id }))}>DISABLE</Button
				>
			{:else}
				<Button
					variant="ghost"
					size="xs"
					disabled={busy}
					onclick={() => act(() => opal.plugins.enable({ id: plugin.id }))}>ENABLE</Button
				>
			{/if}
		{/snippet}
		<DetailTable>
			<DetailRow label="State">
				<State value={proc.state} tone={PROCESS_TONES[proc.state] ?? 'muted'} />
			</DetailRow>
			<DetailRow label="PID" value={proc.pid} mono />
			<DetailRow label="Started"><Timestamp value={proc.startedAt} /></DetailRow>
			<DetailRow label="Restarts" value={proc.restarts} mono />
			<DetailRow label="Exit code" value={proc.exitCode} mono />
		</DetailTable>
	</Section>

	<Section title="Log" count={plugin.log.length}>
		{#if plugin.log.length === 0}
			<div class="px-3 py-2 text-sm text-muted-foreground">No log lines.</div>
		{:else}
			<pre
				bind:this={logEl}
				class="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">{plugin.log.join(
					'\n'
				)}</pre>
		{/if}
	</Section>

	<Section title="Panels" count={m.panels.length}>
		<DataTable
			rows={m.panels}
			columns={[
				{ key: 'title', label: 'Title' },
				{ key: 'slot', label: 'Slot', mono: true },
				{ key: 'path', label: 'Path', mono: true }
			]}
			emptyLabel="No panels."
			dense
		/>
	</Section>
</div>

<PreviewDialog {preview} bind:open={previewOpen} oninstalled={() => void invalidateAll()} />
