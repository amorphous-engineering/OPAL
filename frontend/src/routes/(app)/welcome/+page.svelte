<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api, opal } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import { ACTION_SHORTCUTS, NAV_SHORTCUTS } from '#lib/shortcuts.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let busy = $state<'complete' | 'demo' | null>(null);

	/** Clear the onboarding flag, refresh the session, and enter the app. */
	async function finish(to = '/') {
		busy = 'complete';
		try {
			await opal.org.welcome.complete({});
			await session.load();
			await goto(to);
		} catch (e) {
			toastError(e);
		} finally {
			busy = null;
		}
	}

	async function configure() {
		// Organization setup is its own page; the flag clears first so the wizard is not re-offered.
		await finish('/setup/organization');
	}

	async function loadDemo() {
		const ok = await confirm({
			title: 'Load the demo data',
			body: 'Switches to a separate throwaway database seeded with the Mojave Sphinx dataset. Your real database is untouched; exiting the demo deletes the demo file.',
			action: 'LOAD DEMO'
		});
		if (!ok) return;
		busy = 'demo';
		try {
			await api.post('/welcome/load-demo');
			// The session now belongs to the demo database: reload everything.
			window.location.assign('/');
		} catch (e) {
			toastError(e);
			busy = null;
		}
	}
</script>

{#if data.mode === 'setup'}
	<PageHeader title="Welcome to OPAL" />
	<div class="max-w-4xl space-y-4 p-4">
		<DetailTable class="overflow-hidden rounded-lg border border-border bg-card">
			<DetailRow label="What OPAL is"
				>A local-first ERP for hardware projects: parts, stock, procedures, issues and risks in one
				database on this machine.</DetailRow
			>
		</DetailTable>

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			<Section title="Set up organization">
				<div class="space-y-3 p-3 text-sm">
					<p>Organization name, first project, inventory tiers, part numbering and categories.</p>
					<Button size="sm" disabled={busy !== null} onclick={configure}>CONFIGURE</Button>
				</div>
			</Section>
			<Section title="Load demo data">
				<div class="space-y-3 p-3 text-sm">
					<p>
						Mojave Sphinx, an N2O/E85 liquid bipropellant rocket (Half Cat Rocketry HCR-5100): part
						catalog and BOM, published build and launch procedures, live work orders, issues, risks
						and purchase orders.
					</p>
					<Button size="sm" disabled={busy !== null} onclick={loadDemo}
						>{busy === 'demo' ? 'LOADING…' : 'LOAD DEMO'}</Button
					>
				</div>
			</Section>
		</div>

		<div>
			<Button variant="ghost" size="sm" disabled={busy !== null} onclick={() => finish()}
				>SKIP FOR NOW</Button
			>
		</div>
	</div>
{:else}
	<PageHeader title="Orientation">
		{#snippet actions()}
			<Button size="sm" disabled={busy !== null} onclick={() => finish()}>GET STARTED</Button>
		{/snippet}
	</PageHeader>
	<div class="grid max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-2">
		<Section title="What OPAL is">
			<DetailTable>
				<DetailRow label="Database"
					>One SQLite file on this machine. No cloud, no servers.</DetailRow
				>
				<DetailRow label="Network">Other machines on the local network can connect.</DetailRow>
				<DetailRow label="Audit trail"
					>Every create, update and delete is logged with who, when and what. Audit log lists them;
					Ctrl+Z reverts your last change within the hour.</DetailRow
				>
				<DetailRow label="Traceability"
					>Every physical item or batch carries its own OPAL number.</DetailRow
				>
			</DetailTable>
		</Section>

		<Section title="Parts and stock">
			<DetailTable>
				<DetailRow label="Parts"
					>What you build with. Each has a system-unique id and a part number from the organization's
					numbering scheme.</DetailRow
				>
				<DetailRow label="OPAL numbers"
					>One per serialized unit; one per batch for bulk parts.</DetailRow
				>
				<DetailRow label="Tiers"
					>Classify parts by criticality, for example Flight, Ground, Dev. Tiers are configured per
					organization.</DetailRow
				>
				<DetailRow label="Stock"
					>Quantity, location, lot, expiration and calibration per OPAL number.</DetailRow
				>
				<DetailRow label="BOM">Which components go into an assembly, and how many.</DetailRow>
				<DetailRow label="Purchases"
					>Purchase orders receive into stock and create the OPAL numbers.</DetailRow
				>
			</DetailTable>
		</Section>

		<Section title="Templates and executions">
			<DetailTable>
				<DetailRow label="Templates"
					>Step-by-step work instructions. Write once, run many times.</DetailRow
				>
				<DetailRow label="Versions"
					>Publishing snapshots a template. Editing the template never changes a published version.</DetailRow
				>
				<DetailRow label="Executions"
					>A run of a published version. Captures data, tracks time, consumes stock.</DetailRow
				>
				<DetailRow label="Work orders"
					>Executions carry a WO number that groups related work.</DetailRow
				>
				<DetailRow label="Types"
					>OP is operational and has no output. BUILD produces an assembly with a new OPAL number.</DetailRow
				>
				<DetailRow label="Kitting"
					>Templates list the parts and quantities needed; stock is consumed during the run.</DetailRow
				>
			</DetailTable>
		</Section>

		<Section title="Issues and risks">
			<DetailTable>
				<DetailRow label="Non-conformance"
					>Hardware does not meet spec: a should-be and an actual.</DetailRow
				>
				<DetailRow label="Bug / task / improvement"
					>Defects, general work items, and requested enhancements.</DetailRow
				>
				<DetailRow label="From execution"
					>A non-conformance logged during a run creates a linked issue and can hold the run.</DetailRow
				>
				<DetailRow label="Links">Issues link to parts, templates and executions.</DetailRow>
				<DetailRow label="Risks"
					>Condition, departure, asset, consequence. Probability times impact (1 to 5 each) gives
					the score: low up to 5, medium 6 to 12, high above 12. Acceptance is a signature.</DetailRow
				>
			</DetailTable>
		</Section>

		<Section title="Navigation" class="lg:col-span-2">
			<div class="grid grid-cols-1 gap-x-8 md:grid-cols-2">
				<DetailTable>
					{#each ACTION_SHORTCUTS as s (s.keys)}
						<DetailRow label={s.keys} mono>{s.label}</DetailRow>
					{/each}
				</DetailTable>
				<DetailTable>
					<DetailRow label="Go to"
						>{NAV_SHORTCUTS.map((s) => `${s.keys.replace('Alt+', '')} ${s.label}`).join(
							' · '
						)}</DetailRow
					>
				</DetailTable>
			</div>
		</Section>
	</div>
{/if}
