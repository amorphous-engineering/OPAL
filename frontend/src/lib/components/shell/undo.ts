/**
 * Undo the signed-in user's most recent change (server window: one hour).
 * One flow for every entry point: the Ctrl/Cmd+Z shortcut and the audit page.
 */
import { invalidateAll } from '$app/navigation';
import { ApiError, opal } from '#lib/api.js';
import type { UndoPreview } from '@opal/shared';
import { confirm, toast, toastError } from '#lib/components/opal/index.js';

let busy = false;

export async function undoLast(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		let preview: UndoPreview;
		try {
			preview = await opal.platform.undo.preview({});
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				toast('Nothing to undo');
				return;
			}
			throw e;
		}
		if (!preview.canUndo) {
			toast.error(preview.reason ?? 'The last change cannot be undone');
			return;
		}
		const ok = await confirm({
			title: preview.summary,
			body: 'Reverts your most recent change.',
			action: 'UNDO'
		});
		if (!ok) return;
		const result = await opal.platform.undo.last({});
		toast.success(result.summary);
		await invalidateAll();
	} catch (e) {
		toastError(e, 'Undo failed');
	} finally {
		busy = false;
	}
}
