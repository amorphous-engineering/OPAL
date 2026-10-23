<script lang="ts">
	// Publish the draft as a new immutable version. Draft parts in the kit or
	// outputs refuse the publish with a structured 409; the refusal is shown
	// here with a per-part ACTIVATE, and the publish retries once none remain.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { toast, toastError } from '#lib/components/opal/index.js';

	interface DraftPart {
		id: number;
		internal_pn: string | null;
		name: string;
	}

	let {
		open = $bindable(false),
		procedureId,
		nextVersion,
		unchanged,
		onpublished
	}: {
		open: boolean;
		procedureId: number;
		nextVersion: number;
		/** Draft equals the current version: nothing new to publish. */
		unchanged: boolean;
		onpublished: () => void | Promise<void>;
	} = $props();

	let note = $state('');
	let busy = $state(false);
	let drafts = $state<DraftPart[]>([]);
	let activating = $state<number | null>(null);

	$effect(() => {
		if (open) {
			note = '';
			drafts = [];
		}
	});

	async function publish() {
		busy = true;
		try {
			const v = await api.post<{ version_number: number }>(`/procedures/${procedureId}/publish`, {
				change_note: note.trim() || null
			});
			open = false;
			toast.success(`Published v${v.version_number}`);
			await onpublished();
		} catch (e) {
			if (
				e instanceof ApiError &&
				e.detail &&
				typeof e.detail === 'object' &&
				(e.detail as { error?: string }).error === 'draft_parts_blocked'
			) {
				drafts = (e.detail as { draft_parts: DraftPart[] }).draft_parts;
			} else toastError(e);
		} finally {
			busy = false;
		}
	}

	async function activate(p: DraftPart) {
		activating = p.id;
		try {
			await api.post(`/parts/${p.id}/activate`, {
				cause: `activated for publish of procedure ${procedureId}`
			});
			drafts = drafts.filter((d) => d.id !== p.id);
			if (drafts.length === 0) await publish();
		} catch (e) {
			toastError(e);
		} finally {
			activating = null;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Publish v{nextVersion}</Dialog.Title>
			<Dialog.Description>
				{#if unchanged}No changes since the current version. Publishing creates an identical
					version.{:else}Freezes the current steps, kit and outputs. Published versions never
					change.{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form
			class="grid grid-cols-1 gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				publish();
			}}
		>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="change-note">Change note</Label>
				<Textarea id="change-note" rows={3} bind:value={note} maxlength={2000} />
			</div>
			{#if drafts.length}
				<div role="alert" class="border border-warn/50 bg-warn-muted p-2 text-xs">
					<p class="mb-1.5 font-mono font-medium text-warn uppercase">Draft parts block publish</p>
					<ul class="grid grid-cols-1 gap-1">
						{#each drafts as p (p.id)}
							<li class="flex items-center gap-2">
								<span class="font-mono">{p.internal_pn ?? '—'}</span>
								<span class="truncate">{p.name}</span>
								<Button
									type="button"
									size="xs"
									variant="outline"
									class="ml-auto"
									disabled={activating !== null}
									onclick={() => activate(p)}>ACTIVATE &amp; CONTINUE</Button
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || drafts.length > 0}>PUBLISH</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
