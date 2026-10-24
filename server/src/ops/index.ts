/** Every implemented operation. HTTP routes and MCP tools are built from this list. */
import type { Impl } from '../registry.ts';
import { authImpls } from './auth.ts';
import { partsImpls } from './parts.ts';

export const impls: Impl[] = [...authImpls, ...partsImpls];
