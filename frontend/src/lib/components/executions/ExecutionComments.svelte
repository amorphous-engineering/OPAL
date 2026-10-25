<script lang="ts">
	// The work order's comment thread. MessageScroller is the transcript (follows new
	// comments, jump-to-newest button); each comment looks like an execution note: author,
	// time, markdown body. The composer sends on Enter (Shift+Enter for a new line). Live: a
	// comment from anyone reloads the thread through the store's event stream.
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as MessageScroller from '#lib/components/ui/message-scroller/index.js';
	import { Avatar, Section, Timestamp } from '#lib/components/opal/index.js';
	import Prose from '#lib/components/procedures/Prose.svelte';
	import { cn } from '#lib/utils.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, class: className }: { store: ExecutionStore; class?: string } = $props();

	let draft = $state('');
	let sending = $state(false);

	const all = $derived(store.comments ?? []);

	// Collapsed shows the last few comments. Remembered per browser for every work order.
	const COLLAPSED_KEY = 'opal.comments.collapsed';
	const LAST = 3;
	let collapsed = $state(readCollapsed());
	function readCollapsed(): boolean {
		try {
			return localStorage.getItem(COLLAPSED_KEY) === '1';
		} catch {
			return false;
		}
	}
	function toggle() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
		} catch {
			/* storage unavailable: the toggle still works for this page */
		}
	}
	const comments = $derived(collapsed ? all.slice(-LAST) : all);

	async function send() {
		const body = draft.trim();
		if (!body || sending) return;
		sending = true;
		if (await store.addComment(body)) draft = '';
		sending = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		}
	}
</script>

<Section
	title="Comments"
	count={all.length || undefined}
	class={cn('lg:flex lg:min-h-0 lg:flex-none lg:flex-col', className)}
>
	{#snippet actions()}
		{#if all.length > LAST}
			<Button size="xs" variant="ghost" aria-pressed={collapsed} onclick={toggle}
				>{collapsed ? 'EXPAND' : 'COLLAPSE'}</Button
			>
		{/if}
	{/snippet}
	{#if store.comments && !all.length}
		<div class="px-3 py-2 text-sm text-muted-foreground">No comments.</div>
	{:else if comments.length}
		<MessageScroller.Provider autoScroll defaultScrollPosition="end">
			<MessageScroller.Root class="min-h-0 flex-1">
				<MessageScroller.Viewport>
					<MessageScroller.Content class="gap-0">
						{#each comments as c (c.id)}
							<MessageScroller.Item
								messageId={`c${c.id}`}
								class="border-b border-border last:border-b-0"
							>
								<article class="grid grid-cols-1 gap-1.5 px-3 py-2">
									<header class="flex items-baseline justify-between gap-3">
										<span class="inline-flex min-w-0 items-center gap-2">
											{#if c.author}<Avatar user={c.author} size="xs" />{/if}
											<span class="truncate text-xs font-semibold">{c.author?.name ?? '—'}</span>
										</span>
										<Timestamp value={c.createdAt} />
									</header>
									<Prose source={c.body} class="text-xs [overflow-wrap:anywhere]" />
								</article>
							</MessageScroller.Item>
						{/each}
					</MessageScroller.Content>
				</MessageScroller.Viewport>
				<MessageScroller.Button aria-label="Newest comment" />
			</MessageScroller.Root>
		</MessageScroller.Provider>
	{/if}
	<!-- The last comment's rule separates the thread from the composer. -->
	<form
		class={cn('p-2', !all.length && 'border-t border-border')}
		onsubmit={(e) => {
			e.preventDefault();
			void send();
		}}
	>
		<InputGroup.Root>
			<InputGroup.Textarea
				bind:value={draft}
				{onkeydown}
				rows={1}
				maxlength={4000}
				placeholder="Comment"
				aria-label="Comment"
				class="max-h-32 min-h-9 text-sm"
			/>
			<InputGroup.Addon align="block-end" class="pt-1">
				<InputGroup.Button
					type="submit"
					variant="default"
					size="icon-sm"
					disabled={!draft.trim() || sending}
					class="ml-auto"
				>
					<ArrowUpIcon />
					<span class="sr-only">Send</span>
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</Section>
