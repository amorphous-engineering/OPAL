/**
 * What a database at LEGACY_HEAD has, whichever way it got there: the tables and columns shared by the
 * files in test/fixtures/legacy-released, each brought forward, and the demo seed. An Alembic stamp only
 * says what a file claims, so this is what the importer checks before it reads anything.
 */
import type { Database } from 'bun:sqlite';
import { ident } from './context.ts';

const HEAD_SHAPE: Record<string, string> = {
	api_token: 'created_at expires_at id last_used_at name revoked_at token_hash updated_at user_id',
	app_setting: 'created_at key updated_at value',
	assembly_component: 'component_opal_number consumption_id created_at id production_id quantity_used updated_at',
	attachment: 'created_at id issue_id kind mime_type note original_filename procedure_id procedure_instance_id purchase_id size_bytes step_execution_id step_note_id stored_filename updated_at uploaded_by_id',
	audit_log: 'action id new_values old_values record_id table_name timestamp user_id',
	baseline_event: 'created_at id label note signed_by_id updated_at',
	baseline_event_item: 'event_id id requirement_id',
	bom_lines: 'assembly_id component_id created_at id notes quantity reference_designator updated_at',
	data_point: 'created_at dataset_id id recorded_at step_execution_id updated_at values',
	dataset: 'created_at deleted_at description id name procedure_id schema updated_at',
	designator_sequence: 'created_at designator_type last_value updated_at',
	inventory_consumption: 'consumed_by_id consumption_type created_at id inventory_record_id notes procedure_instance_id quantity step_execution_id updated_at usage_type',
	inventory_production: 'created_at id inventory_record_id notes procedure_instance_id produced_by_id produced_opal_number quantity serial_number status updated_at',
	inventory_record: 'alias calibration_due_at created_at expiration_date id last_calibrated_at last_counted_at location lot_number opal_number part_id quantity source_production_id source_purchase_line_id source_type updated_at',
	issue: 'actual actual_behavior assigned_to_id closed_at closed_by_id containment containment_step_id corrective_action created_at deleted_at description disposition_rationale disposition_type dispositioned_at dispositioned_by_id expected_behavior expected_benefit id issue_number issue_type part_id priority procedure_id procedure_instance_id raised_by_id raised_step_id review_requested_at review_requested_by_id root_cause should_be status steps_to_reproduce title updated_at work_started_at work_started_by_id',
	issue_comment: 'body created_at id issue_id updated_at user_id',
	issue_reference: 'created_at id issue_id notes reference_type reference_value updated_at',
	kit: 'created_at id part_id procedure_id quantity_required updated_at',
	master_procedure: 'created_at current_version_id deleted_at description id name procedure_type status template_number updated_at',
	notification: 'actor_id body created_at dismissed_at href id kind priority read_at subject_id subject_type title updated_at user_id',
	part: 'activated_at activated_by_id activation_cause calibration_interval_days category created_at deleted_at description external_pn id internal_pn is_tooling lifecycle_state metadata name parent_id procurement reorder_point tier tracking_type unit_of_measure updated_at',
	part_requirements: 'created_at id notes part_id requirement_id requirement_ref_id status updated_at verified_at verified_by_id',
	passkey_credential: 'aaguid created_at credential_id id last_used_at name public_key sign_count transports updated_at user_id',
	procedure_instance: 'completed_at created_at id participants priority procedure_id scheduled_start_at started_at started_by_id status target_completion_at updated_at version_id work_order_number',
	procedure_output: 'created_at id part_id procedure_id quantity_produced updated_at',
	procedure_step: 'callouts created_at estimated_duration_minutes id instructions is_contingency level order parent_step_id procedure_id required_data_schema required_role requires_signoff signoffs step_number strict_sequence title updated_at workcenter_id',
	procedure_version: 'content created_at created_by_id id procedure_id updated_at version_number',
	purchase: 'created_at created_by_id destination id notes ordered_at received_at received_by_id reference status supplier supplier_id supplier_reference target_date updated_at',
	purchase_expense: 'created_at id notes part_id purchase_id purchase_line_id quantity received_at tier total_cost unit_cost updated_at',
	purchase_line: 'created_at destination id notes part_id purchase_id qty_ordered qty_received unit_cost updated_at',
	requirement: 'baselined_at baselined_by_id category created_at deleted_at id level lifecycle_state parent_id rationale req_number revision stale statement supersedes_id tbd tbr tbr_due tbr_owner_id title updated_at verification_method',
	risk: 'acceptance_rationale accepted_at accepted_by_id asset_part_id asset_text condition consequence created_at deleted_at departure description disposition id impact last_reviewed_at last_reviewed_by_id owner_id probability realized_issue_id residual_impact residual_probability risk_number title updated_at watch_contingency watch_observable watch_threshold',
	risk_issue_link: 'created_at id issue_id risk_id role updated_at',
	risk_reference: 'created_at id notes reference_type reference_value risk_id updated_at',
	role: 'created_at deleted_at description id is_system key name updated_at',
	role_gate: 'gate id role_id',
	step_dependency: 'created_at depends_on_step_id id step_id updated_at',
	step_execution: 'ad_hoc_host_order ad_hoc_issue_id completed_at completed_by_id created_at data_captured first_focused_at id instance_id instructions level parent_step_order required_data_schema requires_signoff signed_off_at signed_off_by_id signoffs started_at status step_number step_number_str title updated_at workcenter_id',
	step_focus: 'created_at focused_at id instance_id step_execution_id updated_at user_id',
	step_image: 'attachment_id caption created_at id position step_id updated_at',
	step_kit: 'created_at id notes part_id quantity_required step_id updated_at usage_type',
	step_note: 'author_id body created_at id step_execution_id updated_at',
	step_signoff: 'created_at id label role signed_at signed_by_id slot step_execution_id updated_at',
	stock_test_result: 'created_at id inventory_record_id notes result template_id test_name tested_at tested_by_id updated_at value',
	stock_transfer: 'created_at id notes part_id quantity source_inventory_id source_location source_lot_number status target_inventory_id target_location target_lot_number transferred_at transferred_by_id updated_at',
	supplier: 'address code created_at deleted_at description email id is_active name notes phone updated_at website',
	supplier_part: 'created_at id is_preferred notes part_id supplier_id updated_at vendor_pn',
	test_template: 'created_at description id max_value min_value name part_id required sort_order test_type unit updated_at',
	user: 'avatar_filename avatar_mime avatar_source avatar_updated_at created_at current_activity email id is_active is_admin job_title last_seen_at name needs_onboarding needs_profile_setup oidc_issuer oidc_subject password_hash phone updated_at username workcenter_id',
	user_role: 'granted_at granted_by_id id role_id user_id',
	workcenter: 'code created_at description id is_active location name updated_at',
};

/** Every table and column the importer needs and this file lacks. */
export function missingFromHead(db: Database): string[] {
	const out: string[] = [];
	for (const [table, columns] of Object.entries(HEAD_SHAPE)) {
		const have = new Set((db.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((c) => c.name));
		if (!have.size) out.push(table);
		else for (const column of columns.split(' ')) if (!have.has(column)) out.push(`${table}.${column}`);
	}
	return out;
}
