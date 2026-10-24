<script lang="ts">
	// Field-level detail of one audit entry. Updates show was → now; creates and
	// deletes list the populated fields.
	import { formatValue, fieldName, type AuditEntry } from './audit.js';

	let { entry }: { entry: AuditEntry } = $props();
	const cols = $derived(
		entry.action === 'update'
			? ['FIELD', 'WAS', 'NOW']
			: ['FIELD', entry.action === 'create' ? 'VALUE' : 'WAS']
	);
</script>

{#if entry.changes.length === 0}
	<div class="px-3 py-1.5 font-mono text-xs text-muted-foreground">FIELDS — none recorded</div>
{:else}
	<table class="w-full border-collapse text-xs">
		<thead>
			<tr class="border-b border-border">
				{#each cols as c (c)}
					<th
						class="h-6 px-3 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
						>{c}</th
					>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each entry.changes as c (c.field)}
				<tr class="border-b border-border last:border-b-0">
					<td class="w-48 px-3 py-1 align-top font-mono text-muted-foreground" title={c.field}
						>{fieldName(c.field)}</td
					>
					{#if entry.action === 'update'}
						<td class="max-w-md px-3 py-1 align-top font-mono break-words text-error"
							>{formatValue(c.old, c.oldLabel)}</td
						>
						<td class="max-w-md px-3 py-1 align-top font-mono break-words text-ok"
							>{formatValue(c.new, c.newLabel)}</td
						>
					{:else}
						<td class="max-w-2xl px-3 py-1 align-top font-mono break-words"
							>{entry.action === 'create'
								? formatValue(c.new, c.newLabel)
								: formatValue(c.old, c.oldLabel)}</td
						>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
