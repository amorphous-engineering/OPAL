<script lang="ts">
	// Redline: an ad-hoc OP inserted into a running work order, authorised by an
	// open NC on the host OP. It gates the host and rides the NC's disposition.
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { DocOp } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let { store, op, preselect }: { store: ExecutionStore; op: DocOp; preselect?: number } = $props();

	// svelte-ignore state_referenced_locally
	let issueId = $state(
		String(op.open_ncs.find((n) => n.id === preselect)?.id ?? op.open_ncs[0]?.id ?? '')
	);
	let title = $state('');
	let steps = $state([{ title: '', instructions: '', requires_signoff: false }]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await store.createRedline({
				issue_id: Number(issueId),
				title: title.trim(),
				steps: steps.map((s) => ({
					title: s.title.trim(),
					instructions: s.instructions.trim() || null,
					requires_signoff: s.requires_signoff
				}))
			});
			store.closeDialog();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create redline';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid gap-3" onsubmit={submit}>
	<Dialog.Header>
		<Dialog.Title>Add redline OP</Dialog.Title>
		<Dialog.Description>
			On <span class="font-mono text-foreground">OP {op.number}</span>
			{op.title}
		</Dialog.Description>
	</Dialog.Header>
	<FormRow label="Authorizing NC" for="rl-issue" required>
		<NativeSelect id="rl-issue" class="w-full" bind:value={issueId} required>
			{#each op.open_ncs as nc (nc.id)}
				<option value={String(nc.id)}>{nc.issue_number} {nc.title}</option>
			{/each}
		</NativeSelect>
	</FormRow>
	<FormRow label="Redline OP title" for="rl-title" required>
		<Input id="rl-title" bind:value={title} maxlength={255} required autofocus />
	</FormRow>
	<div class="grid gap-2">
		<span class="label">Sub-steps</span>
		{#each steps as s, i (i)}
			<div class="grid gap-1.5 border border-border p-2">
				<div class="flex items-center gap-2">
					<span class="font-mono text-xs text-muted-foreground">{i + 1}.</span>
					<Input
						bind:value={s.title}
						placeholder="Step title"
						maxlength={255}
						required
						aria-label={`Sub-step ${i + 1} title`}
					/>
					<label class="flex items-center gap-1.5 text-xs whitespace-nowrap">
						<Checkbox bind:checked={s.requires_signoff} />
						<span class="font-mono">SIGN-OFF</span>
					</label>
					<Button
						size="xs"
						variant="outline"
						disabled={steps.length === 1}
						onclick={() => (steps = steps.filter((_, j) => j !== i))}>REMOVE</Button
					>
				</div>
				<Textarea
					rows={2}
					bind:value={s.instructions}
					placeholder="Instructions (markdown)"
					aria-label={`Sub-step ${i + 1} instructions`}
				/>
			</div>
		{/each}
		<div>
			<Button
				size="xs"
				variant="outline"
				onclick={() =>
					(steps = [...steps, { title: '', instructions: '', requires_signoff: false }])}
				>+ ADD STEP</Button
			>
		</div>
	</div>
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={() => store.closeDialog()}>CANCEL</Button>
		<Button type="submit" disabled={busy || !title.trim() || steps.some((s) => !s.title.trim())}
			>CREATE REDLINE</Button
		>
	</Dialog.Footer>
</form>
