/** Every operation contract, grouped by area. The client mirrors this tree. */
import { auth } from './domains/auth.ts';
import { datasets } from './domains/datasets.ts';
import { execution } from './domains/execution.ts';
import { extensions } from './domains/extensions.ts';
import { inventory } from './domains/inventory.ts';
import { issues } from './domains/issues.ts';
import { org } from './domains/org.ts';
import { parts } from './domains/parts.ts';
import { platform } from './domains/platform.ts';
import { procedures } from './domains/procedures.ts';
import { purchasing } from './domains/purchasing.ts';
import { reports } from './domains/reports.ts';
import { requirements } from './domains/requirements.ts';
import { risks } from './domains/risks.ts';

export const contracts = { auth, datasets, execution, extensions, inventory, issues, org, parts, platform, procedures, purchasing, reports, requirements, risks };
export type Contracts = typeof contracts;
