<script lang="ts">
	// The bottom status line: server state, the live database file, and UTC time.
	// `online` comes from the presence heartbeat in the app layout.
	let { dbPath, online }: { dbPath: string; online: boolean } = $props();

	const utc = () => `${new Date().toISOString().replace('T', ' ').slice(0, 19)}Z`;
	let now = $state(utc());

	$effect(() => {
		const timer = setInterval(() => (now = utc()), 1000);
		return () => clearInterval(timer);
	});
</script>

<footer
	class="sticky bottom-0 z-30 flex h-6 items-center gap-4 border-t border-border bg-muted px-3 font-mono text-xs text-muted-foreground"
>
	<span class={['whitespace-nowrap', online ? 'text-ok' : 'text-error']}>
		STATUS: {online ? 'READY' : 'OFFLINE'}
	</span>
	<!-- rtl: a long path loses its start, so the file name stays visible -->
	<span class="min-w-0 flex-1 truncate text-left [direction:rtl]" title={dbPath}>
		<bdi>DB: {dbPath}</bdi>
	</span>
	<time class="whitespace-nowrap" datetime={now}>{now}</time>
</footer>
