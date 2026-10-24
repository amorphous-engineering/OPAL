/**
 * Inventory service. Other areas import from here:
 *
 *   balanceOf, balancesForPart, onHandForPart, onHandByPart   quantities (sums of the ledger)
 *   receiveStock    purchasing: stock arrives
 *   consumeStock    execution: material or tooling used
 *   produceStock    execution: an item is made
 *   createStockRecord, linkComponents   execution: reserve an OPAL number, record genealogy
 *   calibrationReport, expiringStock, lowStockParts   the overview
 */
export * from './ledger.ts';
export * from './records.ts';
export * from './moves.ts';
export * from './genealogy.ts';
export * from './tests.ts';
export * from './calibration.ts';
export * from './detail.ts';
export * from './labels.ts';
