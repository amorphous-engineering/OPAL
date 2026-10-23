/**
 * Whether a component renders inside an existing panel frame (a Section or a list's
 * ListFrame). An empty table inside a frame is only its "No …" line; on its own it draws
 * the frame itself, so an empty table keeps the shape it has with content.
 */
import { getContext, setContext } from 'svelte';

const FRAMED = Symbol('opal.framed');

export function provideFrame(): void {
	setContext(FRAMED, true);
}

export function inFrame(): boolean {
	return getContext<boolean | undefined>(FRAMED) ?? false;
}
