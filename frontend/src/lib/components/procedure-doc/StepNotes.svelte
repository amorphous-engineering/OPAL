<script lang="ts">
	// The running notes log: timestamped, authored, append-only. Its own labelled
	// block, never part of the capture fields. A record, not a control: present
	// in every status, including on finished work orders.
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { datetime, iso } from '#lib/format.js';
	import { useDoc } from './controller.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();

	let body = $state('');
	let busy = $state(false);

	const initials = (name: string | null) =>
		name
			? name
					.split(/\s+/)
					.filter(Boolean)
					.map((p, i, a) => (i === 0 || i === a.length - 1 ? p[0] : ''))
					.join('')
					.toUpperCase()
			: '—';

	async function submit(e: Event) {
		e.preventDefault();
		const text = body.trim();
		if (!text || !ctl.actions.addNote || busy) return;
		busy = true;
		try {
			if (await ctl.actions.addNote(step, text)) body = '';
		} finally {
			busy = false;
		}
	}
</script>

{#if step.notes.length || ctl.actions.addNote}
	<div class="grid gap-1 border-t border-border pt-2" data-notes>
		<span class="label">Notes</span>
		{#each step.notes as n (n.id)}
			<div class="font-mono text-xs text-muted-foreground">
				<time datetime={iso(n.created_at)} title={iso(n.created_at)}
					>{datetime(n.created_at).slice(11)}</time
				>
				{initials(n.author)} · <span class="whitespace-pre-wrap text-foreground">{n.body}</span>
			</div>
		{/each}
		{#if ctl.actions.addNote}
			<form class="flex items-center gap-2" onsubmit={submit}>
				<Input
					bind:value={body}
					maxlength={2000}
					placeholder="Add note"
					aria-label={`Add note to ${step.number}`}
					class="h-7 max-w-xl font-mono"
					data-note-input={step.order}
				/>
				<Button type="submit" size="xs" variant="outline" disabled={busy || !body.trim()}
					>ADD</Button
				>
			</form>
		{/if}
	</div>
{/if}
