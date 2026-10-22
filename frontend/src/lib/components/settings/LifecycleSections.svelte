<script lang="ts">
	// Admin-only: demo database switching and factory reset. Both replace the
	// database under every signed-in user, so each finishes with a full reload.
	import {
		confirm,
		DetailRow,
		DetailTable,
		Section,
		State,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import type { LifecycleState } from './types.js';

	let { lifecycle }: { lifecycle: LifecycleState } = $props();

	let current = $derived(lifecycle);
	let busy = $state(false);

	function reload(to: string) {
		session.set(null);
		window.location.assign(to);
	}

	async function enter() {
		const ok = await confirm({
			title: current.demo_file_exists ? 'Resume the demo?' : 'Enter the demo?',
			body: 'The whole instance switches to a separate demo database for every user until you exit. Your real data is not touched.',
			action: current.demo_file_exists ? 'RESUME DEMO' : 'ENTER DEMO'
		});
		if (!ok) return;
		busy = true;
		try {
			await api.post('/settings/demo/enter');
			reload('/');
		} catch (err) {
			toastError(err);
			busy = false;
		}
	}

	async function exit() {
		const ok = await confirm({
			title: 'Exit the demo?',
			body: 'The demo database and everything in it is deleted. Everyone is signed out.',
			action: 'EXIT AND DELETE',
			destructive: true
		});
		if (!ok) return;
		busy = true;
		try {
			await api.post('/settings/demo/exit');
			reload('/login');
		} catch (err) {
			toastError(err);
			busy = false;
		}
	}

	async function removeFile() {
		const ok = await confirm({
			title: 'Delete the demo database file?',
			body: 'The demo and everything in it is gone.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			current = await api.del<LifecycleState>('/settings/demo');
		} catch (err) {
			toastError(err);
		}
	}

	async function reset() {
		const ok = await confirm({
			title: 'Factory reset this instance?',
			body: 'Parts, inventory, procedures, executions, users, settings, attachments and any demo database are erased. There is no undo. The instance returns to first-run setup.',
			action: 'FACTORY RESET',
			destructive: true,
			typeToConfirm: 'RESET'
		});
		if (!ok) return;
		busy = true;
		try {
			await api.post('/settings/factory-reset', { confirm: 'RESET' });
			reload('/setup');
		} catch (err) {
			toastError(err);
			busy = false;
		}
	}
</script>

<Section title="Demo data">
	<DetailTable>
		<DetailRow label="State">
			{#if current.demo_active}<State value="demo" tone="warn" label="ACTIVE" />
			{:else if current.demo_file_exists}<State value="present" tone="info" label="FILE PRESENT" />
			{:else}<span class="font-mono text-xs">NONE</span>{/if}
		</DetailRow>
		<DetailRow label="Database"
			><span class="font-mono break-all">{current.demo_db_path}</span></DetailRow
		>
	</DetailTable>
	<div class="flex gap-2 border-t border-border p-3">
		{#if current.demo_active}
			<Button size="sm" disabled={busy} onclick={exit}>EXIT DEMO</Button>
		{:else}
			<Button size="sm" disabled={busy} onclick={enter}
				>{current.demo_file_exists ? 'RESUME DEMO' : 'ENTER DEMO'}</Button
			>
			{#if current.demo_file_exists}
				<Button variant="outline" size="sm" disabled={busy} onclick={removeFile}
					>DELETE DEMO FILE</Button
				>
			{/if}
		{/if}
	</div>
</Section>

<Section title="Factory reset" class="border-error/50">
	<div class="p-3">
		<Button variant="destructive" size="sm" disabled={busy} onclick={reset}>FACTORY RESET</Button>
	</div>
</Section>
