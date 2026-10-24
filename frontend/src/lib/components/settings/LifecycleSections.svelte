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
	import { opal } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import { FACTORY_RESET_WORD, type LifecycleState } from '@opal/shared';

	let { lifecycle }: { lifecycle: LifecycleState } = $props();

	let current = $derived(lifecycle);
	let busy = $state(false);

	function reload(to: string) {
		session.set(null);
		window.location.assign(to);
	}

	async function enter() {
		const ok = await confirm({
			title: current.demoFileExists ? 'Resume the demo?' : 'Enter the demo?',
			body: 'The whole instance switches to a separate demo database for every user until you exit. Your real data is not touched.',
			action: current.demoFileExists ? 'RESUME DEMO' : 'ENTER DEMO'
		});
		if (!ok) return;
		busy = true;
		try {
			await opal.reports.lifecycle.enterDemo({});
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
			await opal.reports.lifecycle.exitDemo({});
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
			current = await opal.reports.lifecycle.deleteDemo({});
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
			typeToConfirm: FACTORY_RESET_WORD
		});
		if (!ok) return;
		busy = true;
		try {
			await opal.reports.lifecycle.factoryReset({ confirm: FACTORY_RESET_WORD });
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
			{#if current.demoActive}<State value="demo" tone="warn" label="ACTIVE" />
			{:else if current.demoFileExists}<State value="present" tone="info" label="FILE PRESENT" />
			{:else}<span class="font-mono text-xs">NONE</span>{/if}
		</DetailRow>
		<DetailRow label="Database"
			><span class="font-mono break-all">{current.demoDbPath}</span></DetailRow
		>
	</DetailTable>
	<div class="flex gap-2 border-t border-border p-3">
		{#if current.demoActive}
			<Button size="sm" disabled={busy} onclick={exit}>EXIT DEMO</Button>
		{:else}
			<Button size="sm" disabled={busy} onclick={enter}
				>{current.demoFileExists ? 'RESUME DEMO' : 'ENTER DEMO'}</Button
			>
			{#if current.demoFileExists}
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
