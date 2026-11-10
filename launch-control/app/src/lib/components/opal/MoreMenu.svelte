<script lang="ts">
	// Exceptional acts of a record: void, cancel, obsolete, delete. They sit here, not beside the
	// title, so the header shows the move the record is waiting on. Renders nothing when no item
	// applies, so a page lists every act and marks the ones that do not apply with `when: false`.
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	export interface MoreItem {
		label: string;
		onselect: () => void;
		/** A strike or a delete. The label takes the error colour inside the open menu. */
		strike?: boolean;
		/** Whether this act applies right now. Absent means yes. */
		when?: boolean;
	}

	let { items }: { items: MoreItem[] } = $props();

	const shown = $derived(items.filter((i) => i.when !== false));
</script>

{#if shown.length}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button size="sm" variant="ghost" {...props} aria-label="More actions">MORE</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-48">
			{#each shown as item (item.label)}
				<DropdownMenu.Item
					class={item.strike ? 'text-destructive' : ''}
					onSelect={() => item.onselect()}>{item.label}</DropdownMenu.Item
				>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
