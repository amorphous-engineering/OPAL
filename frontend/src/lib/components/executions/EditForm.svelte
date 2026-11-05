<script lang="ts">
	// EDIT on a work order: project, priority and dates, which stay pencil while it is open. Each
	// change saves as it is made, and DONE in the header closes the strip.
	import { fromInput, toInput } from '#lib/format.js';
	import { ErrorBanner, toastError } from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte';
	import { EXECUTION_PRIORITIES } from '@opal/shared';
	import type { InstanceFacts } from '#lib/execution/types.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, facts }: { store: ExecutionStore; facts: InstanceFacts } = $props();

	// svelte-ignore state_referenced_locally
	let projectId = $state(facts.project.id);
	let error = $state<string | null>(null);

	async function save(patch: Parameters<ExecutionStore['update']>[0]) {
		error = null;
		try {
			await store.update(patch);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Not saved';
			toastError(err);
			projectId = facts.project.id;
		}
	}
	const when = (v: string) => (v ? (fromInput(v) ?? null) : null);
</script>

<form
	class="grid grid-cols-1 gap-2 border-b border-border bg-muted/30 px-4 py-3"
	aria-label="Edit work order"
	onsubmit={(e) => e.preventDefault()}
>
	<div class="flex flex-wrap items-end gap-3">
		<div class="grid grid-cols-1 gap-1">
			<Label for="wo-project">Project</Label>
			<ProjectSelect
				id="wo-project"
				keep={facts.project.id}
				bind:value={
					() => projectId,
					(v) => {
						if (v === projectId) return;
						projectId = v;
						void save({ projectId: v });
					}
				}
			/>
		</div>
		<div class="grid grid-cols-1 gap-1">
			<Label for="wo-priority">Priority</Label>
			<NativeSelect
				id="wo-priority"
				class="w-32"
				value={facts.priority}
				onchange={(e) =>
					save({ priority: e.currentTarget.value as (typeof EXECUTION_PRIORITIES)[number] })}
			>
				{#each EXECUTION_PRIORITIES as p (p)}<option value={p}>{p.toUpperCase()}</option>{/each}
			</NativeSelect>
		</div>
		<div class="grid grid-cols-1 gap-1">
			<Label for="wo-sched">Scheduled start</Label>
			<Input
				id="wo-sched"
				type="datetime-local"
				class="font-mono"
				value={toInput(facts.scheduled_start_at)}
				onchange={(e) => save({ scheduledStartAt: when(e.currentTarget.value) })}
			/>
		</div>
		<div class="grid grid-cols-1 gap-1">
			<Label for="wo-target">Target completion</Label>
			<Input
				id="wo-target"
				type="datetime-local"
				class="font-mono"
				value={toInput(facts.target_completion_at)}
				onchange={(e) => save({ targetCompletionAt: when(e.currentTarget.value) })}
			/>
		</div>
	</div>
	<ErrorBanner message={error} />
</form>
