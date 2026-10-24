/**
 * Platform services other areas use. Import from here:
 *
 *   import { attach, notify, publish, registerEntity, registerSearchable, registerReversible } from '../platform/index.ts';
 *
 * See each module's header for the contract.
 */
export { attach, detach, detachAll, listFor as attachmentsFor, storeBlob, getBlob, blobPath, purgeOrphanBlobs, type FileInput, type Owner } from './attachments.ts';
export { publish, subscribe, flushEvents, type PublishInput } from './events.ts';
export { notify, priorityFromIssue, type NotifyInput } from './notifications.ts';
export { registerEntity, registerEntityLabel, resolveRef, entityLabel, type EntityRef } from './entities.ts';
export { auditEntries } from './audit.ts';
export { registerSearchable, ftsStatements, ensureFts, type Searchable } from './search.ts';
export { registerReversible, revertRows, type AuditRow, type Reversible } from './undo.ts';
export { mountFiles } from './files.ts';
