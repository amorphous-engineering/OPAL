<script lang="ts">
	// The facts of a plugin before it is installed or updated: manifest, permissions, settings, panels.
	import { goto } from '$app/navigation';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		ErrorBanner,
		Section,
		State,
		toast
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { opal } from '#lib/api.js';
	import type { PluginPreview } from '@opal/shared';
	import PermissionList from './PermissionList.svelte';
	import { pluginError, sourceLabel } from './state.js';

	let {
		preview,
		open = $bindable(false),
		oninstalled
	}: { preview: PluginPreview | null; open: boolean; oninstalled?: () => void } = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) error = null;
	});

	async function install() {
		if (!preview) return;
		busy = true;
		error = null;
		try {
			const p = await opal.plugins.install({ source: sourceLabel(preview), sha: preview.sha });
			toast.success(`${p.name} ${p.version} installed`);
			open = false;
			oninstalled?.();
			await goto(`/settings/plugins/${encodeURIComponent(p.id)}`, { invalidateAll: true });
		} catch (e) {
			error = pluginError(e, 'Could not install');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
		{#if preview}
			{@const m = preview.manifest}
			<Dialog.Header>
				<Dialog.Title>{preview.installed ? 'Update' : 'Install'} {m.name}</Dialog.Title>
			</Dialog.Header>
			<ErrorBanner message={error} />
			<div class="grid gap-3">
				<Section title="Plugin">
					<DetailTable>
						<DetailRow label="Name" value={m.name} />
						<DetailRow label="Id" value={m.id} mono />
						<DetailRow label="Version">
							<span class="font-mono">
								{#if preview.installed}{preview.installed.version} →
								{/if}{m.version}
							</span>
						</DetailRow>
						<DetailRow label="Source" value={sourceLabel(preview)} mono />
						<DetailRow label="SHA">
							<span class="font-mono" title={preview.sha}>{preview.sha.slice(0, 7)}</span>
						</DetailRow>
						<DetailRow label="Summary" value={m.summary} />
						<DetailRow label="Homepage">
							{#if m.homepage}<a
									href={m.homepage}
									target="_blank"
									rel="noreferrer"
									class="font-mono text-info hover:underline">{m.homepage}</a
								>{/if}
						</DetailRow>
						<DetailRow label="OPAL">
							<span class="inline-flex items-center gap-2 font-mono">
								{m.opal}
								{#if !preview.compatible}<State
										value="incompatible"
										badge
										tone="warn"
										label="NOT COMPATIBLE"
									/>{/if}
							</span>
						</DetailRow>
					</DetailTable>
				</Section>

				<Section title="Permissions">
					<PermissionList now={m.permissions} before={preview.installed?.permissions ?? null} />
				</Section>

				<Section title="Settings" count={m.settings.length}>
					<DataTable
						rows={m.settings}
						columns={[
							{ key: 'label', label: 'Label' },
							{ key: 'key', label: 'Key', mono: true },
							{ key: 'type', label: 'Type', mono: true },
							{ key: 'required', label: 'Required', mono: true }
						]}
						emptyLabel="No settings."
						dense
					>
						{#snippet cell(row, col)}
							{#if col.key === 'required'}{row.required ? 'YES' : 'NO'}{:else}{(
									row as Record<string, unknown>
								)[col.key]}{/if}
						{/snippet}
					</DataTable>
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
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (open = false)}>CANCEL</Button>
				<Button onclick={install} disabled={busy}>{preview.installed ? 'UPDATE' : 'INSTALL'}</Button
				>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
