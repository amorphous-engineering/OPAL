/** Shapes served by `opal.reports.overview`. */
import type { Overview } from '@opal/shared';

export type { Overview };
export type IssueRow = Overview['issues']['items'][number];
export type ExecutionRow = Overview['executions']['items'][number];
export type LowStockRow = Overview['lowStock']['items'][number];
export type PurchaseRow = Overview['purchases']['items'][number];
export type StockAttentionRow = Overview['stockAttention']['items'][number];
export type RiskRow = Overview['risks']['items'][number];
