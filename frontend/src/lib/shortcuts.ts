/** Global keyboard shortcuts: one list drives both the handler and the reference on the overview. */
export interface Shortcut {
	keys: string;
	label: string;
	/** Alt+<key> navigates here. */
	alt?: string;
	href?: string;
}

export const NAV_SHORTCUTS: (Shortcut & { alt: string; href: string })[] = [
	{ keys: 'Alt+H', alt: 'h', href: '/', label: 'Overview' },
	{ keys: 'Alt+P', alt: 'p', href: '/parts', label: 'Parts' },
	{ keys: 'Alt+N', alt: 'n', href: '/inventory', label: 'Stock' },
	{ keys: 'Alt+U', alt: 'u', href: '/purchases', label: 'Purchases' },
	{ keys: 'Alt+S', alt: 's', href: '/suppliers', label: 'Suppliers' },
	{ keys: 'Alt+R', alt: 'r', href: '/procedures', label: 'Templates' },
	{ keys: 'Alt+E', alt: 'e', href: '/executions', label: 'Executions' },
	{ keys: 'Alt+W', alt: 'w', href: '/workcenters', label: 'Workcenters' },
	{ keys: 'Alt+I', alt: 'i', href: '/issues', label: 'Issues' },
	{ keys: 'Alt+K', alt: 'k', href: '/risks', label: 'Risks' },
	{ keys: 'Alt+D', alt: 'd', href: '/datasets', label: 'Datasets' },
	{ keys: 'Alt+A', alt: 'a', href: '/audit', label: 'Audit log' }
];

export const ACTION_SHORTCUTS: Shortcut[] = [
	{ keys: '⌘K / Ctrl+K', label: 'Search' },
	{ keys: '⌘Z / Ctrl+Z', label: 'Undo last change' },
	{ keys: 'Alt+T', label: 'Toggle theme' }
];
