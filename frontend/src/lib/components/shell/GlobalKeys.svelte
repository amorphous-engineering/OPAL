<script lang="ts">
	// Global shortcuts that are not the command palette: undo and Alt+letter navigation.
	// Never fires while the user is typing, so text-field undo keeps working.
	import { goto } from '$app/navigation';
	import { mode, setMode } from 'mode-watcher';
	import { NAV_SHORTCUTS } from '#lib/shortcuts.js';
	import { undoLast } from './undo.js';

	function typing(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.defaultPrevented) return;
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
			if (typing(e.target)) return;
			e.preventDefault();
			undoLast();
			return;
		}
		if (e.altKey && !e.ctrlKey && !e.metaKey) {
			// e.code survives layouts where Alt composes a different character (macOS).
			const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
			if (letter === 't') {
				e.preventDefault();
				setMode(mode.current === 'dark' ? 'light' : 'dark');
				return;
			}
			const target = NAV_SHORTCUTS.find((s) => s.alt === letter);
			if (target) {
				e.preventDefault();
				goto(target.href);
			}
		}
	}
</script>

<svelte:window {onkeydown} />
