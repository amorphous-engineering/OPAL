<script lang="ts">
	import { DataTable, Section, State } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { opal } from '#lib/api.js';
	import type { PluginPreview, PluginSummary } from '@opal/shared';
	import PreviewDialog from './PreviewDialog.svelte';
	import { PROCESS_TONES, pluginError, sourceLabel } from './state.js';
	import { ErrorBanner } from '#lib/components/opal/index.js';

	let { plugins }: { plugins: PluginSummary[] } = $props();

	let source = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let preview = $state<PluginPreview | null>(null);
	let open = $state(false);

	async function look(e: SubmitEvent) {
		e.preventDefault();
		if (!source.trim()) return;
		busy = true;
		error = null;
		try {
			preview = await opal.plugins.preview({ source: source.trim() });
			open = true;
		} catch (err) {
			error = pluginError(err, 'Could not read the plugin');
		} finally {
			busy = false;
		}
	}
</script>

<Section title="Plugins" count={plugins.length}>
	<DataTable
		rows={plugins}
		columns={[
			{ key: 'name', label: 'Name' },
			{ key: 'version', label: 'Version', mono: true },
			{ key: 'source', label: 'Source', mono: true },
			{ key: 'sha', label: 'SHA', mono: true },
			{ key: 'state', label: 'State' }
		]}
		href={(p) => `/settings/plugins/${encodeURIComponent(p.id)}`}
		key={(p) => p.id}
		emptyLabel="No plugins installed."
		dense
	>
		{#snippet cell(p, col)}
			{#if col.key === 'name'}{p.name}
			{:else if col.key === 'version'}{p.version}
			{:else if col.key === 'source'}{sourceLabel(p)}
			{:else if col.key === 'sha'}<span title={p.sha}>{p.sha.slice(0, 7)}</span>
			{:else}
				<span class="inline-flex items-center gap-1.5">
					<State
						value={p.enabled ? 'enabled' : 'disabled'}
						badge
						tone={p.enabled ? 'ok' : 'muted'}
					/>
					{#if p.enabled}<State
							value={p.process.state}
							badge
							tone={PROCESS_TONES[p.process.state] ?? 'muted'}
						/>{/if}
				</span>
			{/if}
		{/snippet}
	</DataTable>
	<form class="flex items-center gap-2 border-t border-border p-3" onsubmit={look}>
		<Input
			class="max-w-sm font-mono"
			bind:value={source}
			placeholder="owner/repo@ref"
			aria-label="Plugin source"
			autocomplete="off"
		/>
		<Button type="submit" size="sm" disabled={busy || !source.trim()}>ADD</Button>
	</form>
	{#if error}<div class="px-3 pb-3"><ErrorBanner message={error} /></div>{/if}
</Section>

<PreviewDialog {preview} bind:open />
