/** Every implemented operation. HTTP routes and MCP tools are built from this list. */
import type { Impl } from '../registry.ts';
import { authImpls } from './auth.ts';
import { datasetsImpls } from './datasets.ts';
import { executionImpls } from './execution.ts';
import { extensionsImpls } from './extensions.ts';
import { inventoryImpls } from './inventory.ts';
import { issuesImpls } from './issues.ts';
import { orgImpls } from './org.ts';
import { partsImpls } from './parts.ts';
import { platformImpls } from './platform.ts';
import { proceduresImpls } from './procedures.ts';
import { purchasingImpls } from './purchasing.ts';
import { reportsImpls } from './reports.ts';
import { requirementsImpls } from './requirements.ts';
import { risksImpls } from './risks.ts';

export const impls: Impl[] = [
	...authImpls,
	...datasetsImpls,
	...executionImpls,
	...extensionsImpls,
	...inventoryImpls,
	...issuesImpls,
	...orgImpls,
	...partsImpls,
	...platformImpls,
	...proceduresImpls,
	...purchasingImpls,
	...reportsImpls,
	...requirementsImpls,
	...risksImpls,
];
