/** Every operation contract, grouped by area. The client mirrors this tree. */
import { auth } from './domains/auth.ts';
import { parts } from './domains/parts.ts';

export const contracts = { auth, parts };
export type Contracts = typeof contracts;
