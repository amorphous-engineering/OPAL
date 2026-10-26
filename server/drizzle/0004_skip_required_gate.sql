-- One-time default mapping for the new execution.skipRequired gate. Runs once, so an admin's
-- later edits stick. Roles not yet created get the mapping from ensureSystemRoles.
INSERT OR IGNORE INTO `role_gate` (`role_id`, `gate`)
SELECT `id`, 'execution.skipRequired' FROM `role` WHERE `key` IN ('engineer', 'quality');
