import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as parts from '../services/parts.ts';

export const partsImpls = [
	implement(contracts.parts.list, (ctx, input) => parts.list(ctx, input)),
	implement(contracts.parts.get, (ctx, input) => parts.get(ctx, input.id)),
	implement(contracts.parts.create, (ctx, input) => parts.create(ctx, input))
] as Impl[];
