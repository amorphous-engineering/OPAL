/** Primary navigation. URL scheme matches the API's entity hrefs (/parts/12, /executions/3 …). */
export interface NavItem {
	href: string;
	label: string;
	adminOnly?: boolean;
}

export interface NavGroup {
	label: string;
	items: NavItem[];
}

/** The group shown in the account menu rather than the toolbar. */
export const ACCOUNT_GROUP = 'System';

export const NAV: NavGroup[] = [
	{
		label: 'Inventory',
		items: [
			{ href: '/parts', label: 'Parts' },
			{ href: '/inventory', label: 'Stock' },
			{ href: '/purchases', label: 'Purchases' },
			{ href: '/suppliers', label: 'Suppliers' }
		]
	},
	{
		label: 'Manufacturing',
		items: [
			{ href: '/procedures', label: 'Templates' },
			{ href: '/executions', label: 'Executions' },
			{ href: '/workcenters', label: 'Workcenters' }
		]
	},
	{
		label: 'Quality',
		items: [
			{ href: '/issues', label: 'Issues' },
			{ href: '/risks', label: 'Risks' },
			{ href: '/requirements', label: 'Requirements' },
			{ href: '/datasets', label: 'Datasets' }
		]
	},
	{
		label: 'System',
		items: [
			{ href: '/audit', label: 'Audit log' },
			{ href: '/users', label: 'Users', adminOnly: true },
			{ href: '/settings', label: 'Settings' }
		]
	}
];

export function isActive(pathname: string, href: string): boolean {
	return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
