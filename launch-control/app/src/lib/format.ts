/** State words as people read them: `awaiting_fire` → `AWAITING FIRE`. */
export function stateLabel(value: string | null | undefined): string {
	return value ? value.replace(/[_-]+/g, ' ').toUpperCase() : '—';
}
