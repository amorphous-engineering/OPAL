CREATE TABLE app_setting (
	"key" VARCHAR(64) NOT NULL, 
	value TEXT, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY ("key")
);
CREATE TABLE designator_sequence (
	designator_type VARCHAR(50) NOT NULL, 
	last_value INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (designator_type)
);
CREATE TABLE step_execution (
	instance_id INTEGER NOT NULL, 
	step_number INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	data_captured JSON, 
	started_at DATETIME, 
	first_focused_at DATETIME, 
	completed_at DATETIME, 
	completed_by_id INTEGER, 
	workcenter_id INTEGER, 
	step_number_str VARCHAR(20) NOT NULL, 
	level INTEGER NOT NULL, 
	parent_step_order INTEGER, 
	signed_off_at DATETIME, 
	signed_off_by_id INTEGER, 
	ad_hoc_issue_id INTEGER, 
	ad_hoc_host_order INTEGER, 
	title VARCHAR(255), 
	instructions TEXT, 
	required_data_schema JSON, 
	requires_signoff BOOLEAN NOT NULL, 
	signoffs JSON, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES procedure_instance (id) ON DELETE CASCADE, 
	FOREIGN KEY(completed_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(workcenter_id) REFERENCES workcenter (id) ON DELETE SET NULL, 
	FOREIGN KEY(signed_off_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(ad_hoc_issue_id) REFERENCES issue (id) ON DELETE SET NULL
);
CREATE INDEX ix_step_execution_workcenter_id ON step_execution (workcenter_id);
CREATE INDEX ix_step_execution_ad_hoc_issue_id ON step_execution (ad_hoc_issue_id);
CREATE INDEX ix_step_execution_instance_id ON step_execution (instance_id);
CREATE TABLE extension (
	id VARCHAR(64) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	version VARCHAR(32) NOT NULL, 
	summary TEXT, 
	origin VARCHAR(16) NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	installed_at DATETIME NOT NULL, 
	checksum VARCHAR(64), 
	manifest JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE inventory_record (
	part_id INTEGER NOT NULL, 
	quantity NUMERIC(15, 4) NOT NULL, 
	location VARCHAR(255) NOT NULL, 
	lot_number VARCHAR(100), 
	last_counted_at DATETIME, 
	expiration_date DATE, 
	last_calibrated_at DATETIME, 
	calibration_due_at DATETIME, 
	opal_number VARCHAR(20), 
	alias VARCHAR(100), 
	source_type VARCHAR(20), 
	source_purchase_line_id INTEGER, 
	source_production_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE, 
	FOREIGN KEY(source_purchase_line_id) REFERENCES purchase_line (id) ON DELETE SET NULL, 
	FOREIGN KEY(source_production_id) REFERENCES inventory_production (id) ON DELETE SET NULL
);
CREATE INDEX ix_inventory_record_alias ON inventory_record (alias);
CREATE INDEX ix_inventory_record_expiration_date ON inventory_record (expiration_date);
CREATE INDEX ix_inventory_record_calibration_due_at ON inventory_record (calibration_due_at);
CREATE INDEX ix_inventory_record_location ON inventory_record (location);
CREATE INDEX ix_inventory_record_lot_number ON inventory_record (lot_number);
CREATE INDEX ix_inventory_record_source_purchase_line_id ON inventory_record (source_purchase_line_id);
CREATE INDEX ix_inventory_record_source_production_id ON inventory_record (source_production_id);
CREATE INDEX ix_inventory_record_part_id ON inventory_record (part_id);
CREATE UNIQUE INDEX ix_inventory_record_opal_number ON inventory_record (opal_number);
CREATE TABLE inventory_production (
	inventory_record_id INTEGER NOT NULL, 
	quantity NUMERIC(15, 4) NOT NULL, 
	procedure_instance_id INTEGER, 
	serial_number VARCHAR(100), 
	produced_opal_number VARCHAR(20), 
	status VARCHAR(20) NOT NULL, 
	notes TEXT, 
	produced_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(inventory_record_id) REFERENCES inventory_record (id) ON DELETE CASCADE, 
	FOREIGN KEY(procedure_instance_id) REFERENCES procedure_instance (id) ON DELETE SET NULL, 
	FOREIGN KEY(produced_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_inventory_production_procedure_instance_id ON inventory_production (procedure_instance_id);
CREATE INDEX ix_inventory_production_inventory_record_id ON inventory_production (inventory_record_id);
CREATE INDEX ix_inventory_production_produced_opal_number ON inventory_production (produced_opal_number);
CREATE INDEX ix_inventory_production_serial_number ON inventory_production (serial_number);
CREATE TABLE issue (
	issue_number VARCHAR(20) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	description TEXT, 
	issue_type VARCHAR(20) NOT NULL, 
	status VARCHAR(30) NOT NULL, 
	priority VARCHAR(20) NOT NULL, 
	containment VARCHAR(20) NOT NULL, 
	containment_step_id INTEGER, 
	should_be TEXT, 
	actual TEXT, 
	steps_to_reproduce TEXT, 
	expected_behavior TEXT, 
	actual_behavior TEXT, 
	expected_benefit TEXT, 
	root_cause TEXT, 
	corrective_action TEXT, 
	disposition_type VARCHAR(30), 
	disposition_rationale TEXT, 
	dispositioned_at DATETIME, 
	work_started_at DATETIME, 
	work_started_by_id INTEGER, 
	review_requested_at DATETIME, 
	review_requested_by_id INTEGER, 
	closed_at DATETIME, 
	closed_by_id INTEGER, 
	part_id INTEGER, 
	procedure_id INTEGER, 
	procedure_instance_id INTEGER, 
	raised_step_id INTEGER, 
	raised_by_id INTEGER, 
	assigned_to_id INTEGER, 
	dispositioned_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(containment_step_id) REFERENCES step_execution (id) ON DELETE SET NULL, 
	FOREIGN KEY(work_started_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(review_requested_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(closed_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE SET NULL, 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE SET NULL, 
	FOREIGN KEY(procedure_instance_id) REFERENCES procedure_instance (id) ON DELETE SET NULL, 
	FOREIGN KEY(raised_step_id) REFERENCES step_execution (id) ON DELETE SET NULL, 
	FOREIGN KEY(raised_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(assigned_to_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(dispositioned_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_issue_title ON issue (title);
CREATE INDEX ix_issue_procedure_id ON issue (procedure_id);
CREATE INDEX ix_issue_assigned_to_id ON issue (assigned_to_id);
CREATE UNIQUE INDEX ix_issue_issue_number ON issue (issue_number);
CREATE INDEX ix_issue_raised_step_id ON issue (raised_step_id);
CREATE INDEX ix_issue_part_id ON issue (part_id);
CREATE INDEX ix_issue_procedure_instance_id ON issue (procedure_instance_id);
CREATE TABLE master_procedure (
	template_number VARCHAR(20) NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	description TEXT, 
	procedure_type VARCHAR(20) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	current_version_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(current_version_id) REFERENCES procedure_version (id) ON DELETE SET NULL
);
CREATE INDEX ix_master_procedure_name ON master_procedure (name);
CREATE UNIQUE INDEX ix_master_procedure_template_number ON master_procedure (template_number);
CREATE TABLE role (
	name VARCHAR(50) COLLATE "NOCASE" NOT NULL, 
	description TEXT, 
	"key" VARCHAR(30), 
	is_system BOOLEAN DEFAULT '0' NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	UNIQUE (name), 
	UNIQUE ("key")
);
CREATE TABLE supplier (
	name VARCHAR(255) NOT NULL, 
	code VARCHAR(50), 
	description TEXT, 
	website VARCHAR(255), 
	email VARCHAR(255), 
	phone VARCHAR(50), 
	address TEXT, 
	notes TEXT, 
	is_active BOOLEAN NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	UNIQUE (code)
);
CREATE INDEX ix_supplier_name ON supplier (name);
CREATE TABLE workcenter (
	name VARCHAR(255) NOT NULL, 
	code VARCHAR(50) NOT NULL, 
	description TEXT, 
	location VARCHAR(255), 
	is_active BOOLEAN NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (code)
);
CREATE INDEX ix_workcenter_name ON workcenter (name);
CREATE TABLE dataset (
	name VARCHAR(255) NOT NULL, 
	description TEXT, 
	schema JSON NOT NULL, 
	procedure_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE SET NULL
);
CREATE INDEX ix_dataset_procedure_id ON dataset (procedure_id);
CREATE INDEX ix_dataset_name ON dataset (name);
CREATE TABLE procedure_step (
	procedure_id INTEGER NOT NULL, 
	parent_step_id INTEGER, 
	"order" INTEGER NOT NULL, 
	step_number VARCHAR(20) NOT NULL, 
	level INTEGER NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	instructions TEXT, 
	required_data_schema JSON, 
	is_contingency BOOLEAN NOT NULL, 
	requires_signoff BOOLEAN NOT NULL, 
	signoffs JSON, 
	estimated_duration_minutes INTEGER, 
	required_role VARCHAR(50), 
	callouts JSON, 
	strict_sequence BOOLEAN NOT NULL, 
	workcenter_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE CASCADE, 
	FOREIGN KEY(parent_step_id) REFERENCES procedure_step (id) ON DELETE CASCADE, 
	FOREIGN KEY(workcenter_id) REFERENCES workcenter (id) ON DELETE SET NULL
);
CREATE INDEX ix_procedure_step_procedure_id ON procedure_step (procedure_id);
CREATE INDEX ix_procedure_step_parent_step_id ON procedure_step (parent_step_id);
CREATE INDEX ix_procedure_step_workcenter_id ON procedure_step (workcenter_id);
CREATE TABLE issue_reference (
	issue_id INTEGER NOT NULL, 
	reference_type VARCHAR(20) NOT NULL, 
	reference_value VARCHAR(20) NOT NULL, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_issue_reference_unique UNIQUE (issue_id, reference_type, reference_value), 
	FOREIGN KEY(issue_id) REFERENCES issue (id) ON DELETE CASCADE
);
CREATE INDEX ix_issue_reference_issue_id ON issue_reference (issue_id);
CREATE INDEX ix_issue_reference_reference_value ON issue_reference (reference_value);
CREATE TABLE role_gate (
	role_id INTEGER NOT NULL, 
	gate VARCHAR(50) NOT NULL, 
	id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_role_gate UNIQUE (role_id, gate), 
	FOREIGN KEY(role_id) REFERENCES role (id) ON DELETE CASCADE
);
CREATE INDEX ix_role_gate_role_id ON role_gate (role_id);
CREATE TABLE user (
	name VARCHAR(255) NOT NULL, 
	username VARCHAR(64) NOT NULL, 
	password_hash VARCHAR(255), 
	email VARCHAR(255), 
	oidc_subject VARCHAR(255), 
	oidc_issuer VARCHAR(255), 
	is_active BOOLEAN NOT NULL, 
	is_admin BOOLEAN NOT NULL, 
	needs_profile_setup BOOLEAN NOT NULL, 
	needs_onboarding BOOLEAN NOT NULL, 
	job_title VARCHAR(120), 
	phone VARCHAR(40), 
	workcenter_id INTEGER, 
	avatar_filename VARCHAR(255), 
	avatar_mime VARCHAR(50), 
	avatar_source VARCHAR(10), 
	avatar_updated_at DATETIME, 
	last_seen_at DATETIME, 
	current_activity VARCHAR(255), 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (email), 
	FOREIGN KEY(workcenter_id) REFERENCES workcenter (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ix_user_oidc_subject ON user (oidc_subject);
CREATE UNIQUE INDEX ix_user_username ON user (username);
CREATE TABLE audit_log (
	id INTEGER NOT NULL, 
	timestamp DATETIME NOT NULL, 
	table_name VARCHAR(100) NOT NULL, 
	record_id INTEGER NOT NULL, 
	action VARCHAR(20) NOT NULL, 
	user_id INTEGER, 
	old_values JSON, 
	new_values JSON, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_audit_log_user_id ON audit_log (user_id);
CREATE INDEX ix_audit_log_record_id ON audit_log (record_id);
CREATE INDEX ix_audit_log_table_name ON audit_log (table_name);
CREATE INDEX ix_audit_log_timestamp ON audit_log (timestamp);
CREATE TABLE auth_session (
	user_id INTEGER NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	auth_method VARCHAR(32) NOT NULL, 
	expires_at DATETIME NOT NULL, 
	last_seen_at DATETIME, 
	revoked_at DATETIME, 
	user_agent VARCHAR(255), 
	ip_address VARCHAR(64), 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE
);
CREATE INDEX ix_auth_session_user_id ON auth_session (user_id);
CREATE UNIQUE INDEX ix_auth_session_token_hash ON auth_session (token_hash);
CREATE TABLE api_token (
	user_id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	last_used_at DATETIME, 
	revoked_at DATETIME, 
	expires_at DATETIME, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE
);
CREATE INDEX ix_api_token_user_id ON api_token (user_id);
CREATE UNIQUE INDEX ix_api_token_token_hash ON api_token (token_hash);
CREATE TABLE webauthn_challenge (
	nonce VARCHAR(64) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	rp_id VARCHAR(255) NOT NULL, 
	user_id INTEGER, 
	state_json TEXT NOT NULL, 
	expires_at DATETIME NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE
);
CREATE INDEX ix_webauthn_challenge_user_id ON webauthn_challenge (user_id);
CREATE UNIQUE INDEX ix_webauthn_challenge_nonce ON webauthn_challenge (nonce);
CREATE TABLE passkey_credential (
	user_id INTEGER NOT NULL, 
	credential_id BLOB NOT NULL, 
	public_key BLOB NOT NULL, 
	sign_count INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	aaguid VARCHAR(36), 
	transports VARCHAR(100), 
	last_used_at DATETIME, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_passkey_credential_credential_id ON passkey_credential (credential_id);
CREATE INDEX ix_passkey_credential_user_id ON passkey_credential (user_id);
CREATE TABLE baseline_event (
	label VARCHAR(100), 
	note TEXT, 
	signed_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(signed_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE TABLE data_point (
	dataset_id INTEGER NOT NULL, 
	recorded_at DATETIME NOT NULL, 
	"values" JSON NOT NULL, 
	step_execution_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(dataset_id) REFERENCES dataset (id) ON DELETE CASCADE, 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE SET NULL
);
CREATE INDEX ix_data_point_step_execution_id ON data_point (step_execution_id);
CREATE INDEX ix_data_point_recorded_at ON data_point (recorded_at);
CREATE INDEX ix_data_point_dataset_id ON data_point (dataset_id);
CREATE TABLE step_note (
	step_execution_id INTEGER NOT NULL, 
	author_id INTEGER, 
	body TEXT NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE CASCADE, 
	FOREIGN KEY(author_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_step_note_step_execution_id ON step_note (step_execution_id);
CREATE TABLE step_signoff (
	step_execution_id INTEGER NOT NULL, 
	slot INTEGER NOT NULL, 
	label VARCHAR(100) NOT NULL, 
	role VARCHAR(50), 
	signed_by_id INTEGER, 
	signed_at DATETIME NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_step_signoff_slot UNIQUE (step_execution_id, slot), 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE CASCADE, 
	FOREIGN KEY(signed_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_step_signoff_step_execution_id ON step_signoff (step_execution_id);
CREATE TABLE issue_comment (
	issue_id INTEGER NOT NULL, 
	user_id INTEGER, 
	body TEXT NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(issue_id) REFERENCES issue (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_issue_comment_issue_id ON issue_comment (issue_id);
CREATE TABLE notification (
	user_id INTEGER NOT NULL, 
	actor_id INTEGER, 
	kind VARCHAR(40) NOT NULL, 
	priority VARCHAR(16) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	body TEXT, 
	href VARCHAR(500) NOT NULL, 
	subject_type VARCHAR(40) NOT NULL, 
	subject_id INTEGER NOT NULL, 
	read_at DATETIME, 
	dismissed_at DATETIME, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE, 
	FOREIGN KEY(actor_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_notification_user_id ON notification (user_id);
CREATE INDEX ix_notification_user_created ON notification (user_id, created_at);
CREATE INDEX ix_notification_kind ON notification (kind);
CREATE TABLE onshape_sync_log (
	started_at DATETIME NOT NULL, 
	completed_at DATETIME, 
	direction VARCHAR(10) NOT NULL, 
	"trigger" VARCHAR(20) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	document_id VARCHAR(50), 
	user_id INTEGER, 
	parts_created INTEGER NOT NULL, 
	parts_updated INTEGER NOT NULL, 
	bom_lines_created INTEGER NOT NULL, 
	bom_lines_updated INTEGER NOT NULL, 
	bom_lines_removed INTEGER NOT NULL, 
	errors JSON, 
	summary TEXT, 
	id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES user (id)
);
CREATE TABLE part (
	internal_pn VARCHAR(50), 
	external_pn VARCHAR(255), 
	name VARCHAR(255) NOT NULL, 
	description TEXT, 
	category VARCHAR(100), 
	unit_of_measure VARCHAR(20) NOT NULL, 
	metadata JSON, 
	tracking_type VARCHAR(20) NOT NULL, 
	procurement VARCHAR(10) DEFAULT 'make' NOT NULL, 
	tier INTEGER NOT NULL, 
	reorder_point NUMERIC(15, 4), 
	is_tooling BOOLEAN NOT NULL, 
	calibration_interval_days INTEGER, 
	parent_id INTEGER, 
	lifecycle_state VARCHAR(20) DEFAULT 'draft' NOT NULL, 
	activated_at DATETIME, 
	activated_by_id INTEGER, 
	activation_cause VARCHAR(255), 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_id) REFERENCES part (id), 
	FOREIGN KEY(activated_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_part_external_pn ON part (external_pn);
CREATE INDEX ix_part_is_tooling ON part (is_tooling);
CREATE INDEX ix_part_parent_id ON part (parent_id);
CREATE UNIQUE INDEX ix_part_internal_pn ON part (internal_pn);
CREATE INDEX ix_part_procurement ON part (procurement);
CREATE INDEX ix_part_tier ON part (tier);
CREATE INDEX ix_part_name ON part (name);
CREATE INDEX ix_part_category ON part (category);
CREATE INDEX ix_part_lifecycle_state ON part (lifecycle_state);
CREATE TABLE procedure_version (
	procedure_id INTEGER NOT NULL, 
	version_number INTEGER NOT NULL, 
	content JSON NOT NULL, 
	created_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE CASCADE, 
	FOREIGN KEY(created_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_procedure_version_procedure_id ON procedure_version (procedure_id);
CREATE TABLE step_dependency (
	step_id INTEGER NOT NULL, 
	depends_on_step_id INTEGER NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_step_dependency UNIQUE (step_id, depends_on_step_id), 
	FOREIGN KEY(step_id) REFERENCES procedure_step (id) ON DELETE CASCADE, 
	FOREIGN KEY(depends_on_step_id) REFERENCES procedure_step (id) ON DELETE CASCADE
);
CREATE INDEX ix_step_dependency_step_id ON step_dependency (step_id);
CREATE INDEX ix_step_dependency_depends_on_step_id ON step_dependency (depends_on_step_id);
CREATE TABLE purchase (
	reference VARCHAR(64), 
	supplier VARCHAR(255) NOT NULL, 
	supplier_id INTEGER, 
	supplier_reference VARCHAR(100), 
	status VARCHAR(20) NOT NULL, 
	ordered_at DATETIME, 
	received_at DATETIME, 
	target_date DATE, 
	destination VARCHAR(255), 
	created_by_id INTEGER, 
	received_by_id INTEGER, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(supplier_id) REFERENCES supplier (id) ON DELETE SET NULL, 
	FOREIGN KEY(created_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(received_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_purchase_supplier ON purchase (supplier);
CREATE UNIQUE INDEX ix_purchase_reference ON purchase (reference);
CREATE INDEX ix_purchase_supplier_id ON purchase (supplier_id);
CREATE TABLE requirement (
	req_number VARCHAR(20) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	statement TEXT NOT NULL, 
	rationale TEXT, 
	category VARCHAR(50), 
	parent_id INTEGER, 
	level INTEGER NOT NULL, 
	verification_method VARCHAR(20), 
	tbd BOOLEAN NOT NULL, 
	tbr BOOLEAN NOT NULL, 
	tbr_owner_id INTEGER, 
	tbr_due DATETIME, 
	stale BOOLEAN NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	lifecycle_state VARCHAR(20) NOT NULL, 
	revision INTEGER NOT NULL, 
	baselined_at DATETIME, 
	baselined_by_id INTEGER, 
	supersedes_id INTEGER, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_requirement_number_revision UNIQUE (req_number, revision), 
	FOREIGN KEY(parent_id) REFERENCES requirement (id) ON DELETE SET NULL, 
	FOREIGN KEY(tbr_owner_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(baselined_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(supersedes_id) REFERENCES requirement (id) ON DELETE SET NULL
);
CREATE INDEX ix_requirement_parent_id ON requirement (parent_id);
CREATE INDEX ix_requirement_req_number ON requirement (req_number);
CREATE TABLE user_role (
	user_id INTEGER NOT NULL, 
	role_id INTEGER NOT NULL, 
	granted_by_id INTEGER, 
	granted_at DATETIME NOT NULL, 
	id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_user_role UNIQUE (user_id, role_id), 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE, 
	FOREIGN KEY(role_id) REFERENCES role (id) ON DELETE CASCADE, 
	FOREIGN KEY(granted_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_user_role_role_id ON user_role (role_id);
CREATE INDEX ix_user_role_user_id ON user_role (user_id);
CREATE TABLE baseline_event_item (
	event_id INTEGER NOT NULL, 
	requirement_id INTEGER NOT NULL, 
	id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(event_id) REFERENCES baseline_event (id) ON DELETE CASCADE, 
	FOREIGN KEY(requirement_id) REFERENCES requirement (id) ON DELETE CASCADE
);
CREATE INDEX ix_baseline_event_item_requirement_id ON baseline_event_item (requirement_id);
CREATE INDEX ix_baseline_event_item_event_id ON baseline_event_item (event_id);
CREATE TABLE procedure_instance (
	procedure_id INTEGER NOT NULL, 
	version_id INTEGER NOT NULL, 
	work_order_number VARCHAR(100), 
	status VARCHAR(20) NOT NULL, 
	started_at DATETIME, 
	completed_at DATETIME, 
	started_by_id INTEGER, 
	participants JSON, 
	scheduled_start_at DATETIME, 
	target_completion_at DATETIME, 
	priority INTEGER NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE RESTRICT, 
	FOREIGN KEY(version_id) REFERENCES procedure_version (id) ON DELETE RESTRICT, 
	FOREIGN KEY(started_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_procedure_instance_version_id ON procedure_instance (version_id);
CREATE INDEX ix_procedure_instance_work_order_number ON procedure_instance (work_order_number);
CREATE INDEX ix_procedure_instance_procedure_id ON procedure_instance (procedure_id);
CREATE TABLE test_template (
	part_id INTEGER NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	description TEXT, 
	required BOOLEAN NOT NULL, 
	test_type VARCHAR(50) NOT NULL, 
	min_value NUMERIC(15, 4), 
	max_value NUMERIC(15, 4), 
	unit VARCHAR(50), 
	sort_order INTEGER NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE
);
CREATE INDEX ix_test_template_part_id ON test_template (part_id);
CREATE TABLE stock_transfer (
	source_inventory_id INTEGER, 
	target_inventory_id INTEGER, 
	part_id INTEGER NOT NULL, 
	quantity NUMERIC(15, 4) NOT NULL, 
	source_location VARCHAR(255) NOT NULL, 
	target_location VARCHAR(255) NOT NULL, 
	source_lot_number VARCHAR(100), 
	target_lot_number VARCHAR(100), 
	status VARCHAR(20) NOT NULL, 
	notes TEXT, 
	transferred_by_id INTEGER, 
	transferred_at DATETIME, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(source_inventory_id) REFERENCES inventory_record (id) ON DELETE SET NULL, 
	FOREIGN KEY(target_inventory_id) REFERENCES inventory_record (id) ON DELETE SET NULL, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE, 
	FOREIGN KEY(transferred_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_stock_transfer_part_id ON stock_transfer (part_id);
CREATE INDEX ix_stock_transfer_source_inventory_id ON stock_transfer (source_inventory_id);
CREATE INDEX ix_stock_transfer_target_inventory_id ON stock_transfer (target_inventory_id);
CREATE TABLE onshape_link (
	part_id INTEGER NOT NULL, 
	document_id VARCHAR(50) NOT NULL, 
	element_id VARCHAR(50) NOT NULL, 
	part_id_onshape VARCHAR(50) NOT NULL, 
	onshape_name VARCHAR(255), 
	onshape_part_number VARCHAR(255), 
	last_synced_at DATETIME, 
	pull_hash VARCHAR(64), 
	push_hash VARCHAR(64), 
	stale BOOLEAN NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_onshape_link_part_id ON onshape_link (part_id);
CREATE INDEX ix_onshape_link_document_id ON onshape_link (document_id);
CREATE TABLE part_requirements (
	part_id INTEGER NOT NULL, 
	requirement_id VARCHAR(50) NOT NULL, 
	requirement_ref_id INTEGER, 
	status VARCHAR(20) NOT NULL, 
	notes TEXT, 
	verified_at DATETIME, 
	verified_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE, 
	FOREIGN KEY(requirement_ref_id) REFERENCES requirement (id) ON DELETE SET NULL, 
	FOREIGN KEY(verified_by_id) REFERENCES user (id)
);
CREATE INDEX ix_part_requirements_requirement_ref_id ON part_requirements (requirement_ref_id);
CREATE INDEX ix_part_requirements_requirement_id ON part_requirements (requirement_id);
CREATE INDEX ix_part_requirements_part_id ON part_requirements (part_id);
CREATE TABLE bom_lines (
	assembly_id INTEGER NOT NULL, 
	component_id INTEGER NOT NULL, 
	quantity INTEGER NOT NULL, 
	reference_designator VARCHAR(50), 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(assembly_id) REFERENCES part (id) ON DELETE CASCADE, 
	FOREIGN KEY(component_id) REFERENCES part (id) ON DELETE CASCADE
);
CREATE INDEX ix_bom_lines_component_id ON bom_lines (component_id);
CREATE INDEX ix_bom_lines_assembly_id ON bom_lines (assembly_id);
CREATE TABLE kit (
	procedure_id INTEGER NOT NULL, 
	part_id INTEGER NOT NULL, 
	quantity_required NUMERIC(15, 4) NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE CASCADE, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE RESTRICT
);
CREATE INDEX ix_kit_procedure_id ON kit (procedure_id);
CREATE INDEX ix_kit_part_id ON kit (part_id);
CREATE TABLE procedure_output (
	procedure_id INTEGER NOT NULL, 
	part_id INTEGER NOT NULL, 
	quantity_produced NUMERIC(15, 4) NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE CASCADE, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE RESTRICT
);
CREATE INDEX ix_procedure_output_part_id ON procedure_output (part_id);
CREATE INDEX ix_procedure_output_procedure_id ON procedure_output (procedure_id);
CREATE TABLE step_kit (
	step_id INTEGER NOT NULL, 
	part_id INTEGER NOT NULL, 
	quantity_required NUMERIC(15, 4) NOT NULL, 
	usage_type VARCHAR(20) NOT NULL, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(step_id) REFERENCES procedure_step (id) ON DELETE CASCADE, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE RESTRICT
);
CREATE INDEX ix_step_kit_step_id ON step_kit (step_id);
CREATE INDEX ix_step_kit_part_id ON step_kit (part_id);
CREATE TABLE purchase_line (
	purchase_id INTEGER NOT NULL, 
	part_id INTEGER NOT NULL, 
	qty_ordered NUMERIC(15, 4) NOT NULL, 
	qty_received NUMERIC(15, 4) NOT NULL, 
	unit_cost NUMERIC(15, 4), 
	destination VARCHAR(255), 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(purchase_id) REFERENCES purchase (id) ON DELETE CASCADE, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE RESTRICT
);
CREATE INDEX ix_purchase_line_purchase_id ON purchase_line (purchase_id);
CREATE INDEX ix_purchase_line_part_id ON purchase_line (part_id);
CREATE TABLE risk (
	risk_number VARCHAR(20) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	description TEXT, 
	condition TEXT, 
	departure TEXT, 
	asset_part_id INTEGER, 
	asset_text VARCHAR(255), 
	consequence TEXT, 
	disposition VARCHAR(20) DEFAULT 'open' NOT NULL, 
	owner_id INTEGER, 
	probability INTEGER NOT NULL, 
	impact INTEGER NOT NULL, 
	residual_probability INTEGER, 
	residual_impact INTEGER, 
	accepted_by_id INTEGER, 
	accepted_at DATETIME, 
	acceptance_rationale TEXT, 
	watch_observable VARCHAR(255), 
	watch_threshold VARCHAR(255), 
	watch_contingency TEXT, 
	last_reviewed_at DATETIME, 
	last_reviewed_by_id INTEGER, 
	realized_issue_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	deleted_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(asset_part_id) REFERENCES part (id) ON DELETE SET NULL, 
	FOREIGN KEY(owner_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(accepted_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(last_reviewed_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(realized_issue_id) REFERENCES issue (id) ON DELETE SET NULL
);
CREATE INDEX ix_risk_owner_id ON risk (owner_id);
CREATE INDEX ix_risk_disposition ON risk (disposition);
CREATE INDEX ix_risk_title ON risk (title);
CREATE INDEX ix_risk_asset_part_id ON risk (asset_part_id);
CREATE UNIQUE INDEX ix_risk_risk_number ON risk (risk_number);
CREATE INDEX ix_risk_realized_issue_id ON risk (realized_issue_id);
CREATE TABLE supplier_part (
	supplier_id INTEGER NOT NULL, 
	part_id INTEGER NOT NULL, 
	vendor_pn VARCHAR(255) NOT NULL, 
	is_preferred BOOLEAN NOT NULL, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_supplier_part UNIQUE (supplier_id, part_id), 
	FOREIGN KEY(supplier_id) REFERENCES supplier (id) ON DELETE CASCADE, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE CASCADE
);
CREATE INDEX ix_supplier_part_supplier_id ON supplier_part (supplier_id);
CREATE INDEX ix_supplier_part_part_id ON supplier_part (part_id);
CREATE TABLE attachment (
	original_filename VARCHAR(255) NOT NULL, 
	stored_filename VARCHAR(255) NOT NULL, 
	mime_type VARCHAR(100) NOT NULL, 
	size_bytes BIGINT NOT NULL, 
	kind VARCHAR(20), 
	note TEXT, 
	uploaded_by_id INTEGER, 
	procedure_instance_id INTEGER, 
	step_execution_id INTEGER, 
	step_note_id INTEGER, 
	issue_id INTEGER, 
	procedure_id INTEGER, 
	purchase_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (stored_filename), 
	FOREIGN KEY(uploaded_by_id) REFERENCES user (id) ON DELETE SET NULL, 
	FOREIGN KEY(procedure_instance_id) REFERENCES procedure_instance (id) ON DELETE CASCADE, 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE CASCADE, 
	FOREIGN KEY(step_note_id) REFERENCES step_note (id) ON DELETE CASCADE, 
	FOREIGN KEY(issue_id) REFERENCES issue (id) ON DELETE CASCADE, 
	FOREIGN KEY(procedure_id) REFERENCES master_procedure (id) ON DELETE CASCADE, 
	FOREIGN KEY(purchase_id) REFERENCES purchase (id) ON DELETE CASCADE
);
CREATE INDEX ix_attachment_uploaded_by_id ON attachment (uploaded_by_id);
CREATE INDEX ix_attachment_purchase_id ON attachment (purchase_id);
CREATE INDEX ix_attachment_kind ON attachment (kind);
CREATE INDEX ix_attachment_issue_id ON attachment (issue_id);
CREATE INDEX ix_attachment_step_note_id ON attachment (step_note_id);
CREATE INDEX ix_attachment_procedure_id ON attachment (procedure_id);
CREATE INDEX ix_attachment_procedure_instance_id ON attachment (procedure_instance_id);
CREATE INDEX ix_attachment_step_execution_id ON attachment (step_execution_id);
CREATE TABLE step_focus (
	instance_id INTEGER NOT NULL, 
	step_execution_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	focused_at DATETIME NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_step_focus_user UNIQUE (instance_id, user_id), 
	FOREIGN KEY(instance_id) REFERENCES procedure_instance (id) ON DELETE CASCADE, 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES user (id) ON DELETE CASCADE
);
CREATE INDEX ix_step_focus_step_execution_id ON step_focus (step_execution_id);
CREATE INDEX ix_step_focus_user_id ON step_focus (user_id);
CREATE INDEX ix_step_focus_instance_id ON step_focus (instance_id);
CREATE TABLE inventory_consumption (
	inventory_record_id INTEGER NOT NULL, 
	quantity NUMERIC(15, 4) NOT NULL, 
	consumption_type VARCHAR(20) NOT NULL, 
	usage_type VARCHAR(20) NOT NULL, 
	procedure_instance_id INTEGER, 
	step_execution_id INTEGER, 
	notes TEXT, 
	consumed_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(inventory_record_id) REFERENCES inventory_record (id) ON DELETE CASCADE, 
	FOREIGN KEY(procedure_instance_id) REFERENCES procedure_instance (id) ON DELETE SET NULL, 
	FOREIGN KEY(step_execution_id) REFERENCES step_execution (id) ON DELETE SET NULL, 
	FOREIGN KEY(consumed_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_inventory_consumption_procedure_instance_id ON inventory_consumption (procedure_instance_id);
CREATE INDEX ix_inventory_consumption_inventory_record_id ON inventory_consumption (inventory_record_id);
CREATE INDEX ix_inventory_consumption_step_execution_id ON inventory_consumption (step_execution_id);
CREATE TABLE stock_test_result (
	inventory_record_id INTEGER NOT NULL, 
	template_id INTEGER, 
	test_name VARCHAR(255) NOT NULL, 
	result VARCHAR(20) NOT NULL, 
	value VARCHAR(255), 
	notes TEXT, 
	tested_at DATETIME, 
	tested_by_id INTEGER, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(inventory_record_id) REFERENCES inventory_record (id) ON DELETE CASCADE, 
	FOREIGN KEY(template_id) REFERENCES test_template (id) ON DELETE SET NULL, 
	FOREIGN KEY(tested_by_id) REFERENCES user (id) ON DELETE SET NULL
);
CREATE INDEX ix_stock_test_result_template_id ON stock_test_result (template_id);
CREATE INDEX ix_stock_test_result_inventory_record_id ON stock_test_result (inventory_record_id);
CREATE TABLE purchase_expense (
	purchase_id INTEGER NOT NULL, 
	purchase_line_id INTEGER, 
	part_id INTEGER, 
	quantity NUMERIC(15, 4) NOT NULL, 
	unit_cost NUMERIC(15, 4), 
	total_cost NUMERIC(15, 4), 
	tier INTEGER, 
	received_at DATETIME NOT NULL, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(purchase_id) REFERENCES purchase (id) ON DELETE CASCADE, 
	FOREIGN KEY(purchase_line_id) REFERENCES purchase_line (id) ON DELETE SET NULL, 
	FOREIGN KEY(part_id) REFERENCES part (id) ON DELETE SET NULL
);
CREATE INDEX ix_purchase_expense_purchase_id ON purchase_expense (purchase_id);
CREATE TABLE risk_reference (
	risk_id INTEGER NOT NULL, 
	reference_type VARCHAR(20) NOT NULL, 
	reference_value VARCHAR(20) NOT NULL, 
	notes TEXT, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_risk_reference_unique UNIQUE (risk_id, reference_type, reference_value), 
	FOREIGN KEY(risk_id) REFERENCES risk (id) ON DELETE CASCADE
);
CREATE INDEX ix_risk_reference_reference_value ON risk_reference (reference_value);
CREATE INDEX ix_risk_reference_risk_id ON risk_reference (risk_id);
CREATE TABLE risk_issue_link (
	risk_id INTEGER NOT NULL, 
	issue_id INTEGER NOT NULL, 
	role VARCHAR(20) DEFAULT 'mitigation' NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_risk_issue_link UNIQUE (risk_id, issue_id), 
	FOREIGN KEY(risk_id) REFERENCES risk (id) ON DELETE CASCADE, 
	FOREIGN KEY(issue_id) REFERENCES issue (id) ON DELETE CASCADE
);
CREATE INDEX ix_risk_issue_link_risk_id ON risk_issue_link (risk_id);
CREATE INDEX ix_risk_issue_link_issue_id ON risk_issue_link (issue_id);
CREATE TABLE assembly_component (
	production_id INTEGER NOT NULL, 
	consumption_id INTEGER NOT NULL, 
	component_opal_number VARCHAR(20) NOT NULL, 
	quantity_used NUMERIC(15, 4) NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(production_id) REFERENCES inventory_production (id) ON DELETE CASCADE, 
	FOREIGN KEY(consumption_id) REFERENCES inventory_consumption (id) ON DELETE CASCADE
);
CREATE INDEX ix_assembly_component_consumption_id ON assembly_component (consumption_id);
CREATE INDEX ix_assembly_component_component_opal_number ON assembly_component (component_opal_number);
CREATE INDEX ix_assembly_component_production_id ON assembly_component (production_id);
CREATE TABLE step_image (
	step_id INTEGER NOT NULL, 
	attachment_id INTEGER NOT NULL, 
	caption VARCHAR(255), 
	position INTEGER NOT NULL, 
	id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(step_id) REFERENCES procedure_step (id) ON DELETE CASCADE, 
	FOREIGN KEY(attachment_id) REFERENCES attachment (id) ON DELETE RESTRICT
);
CREATE INDEX ix_step_image_attachment_id ON step_image (attachment_id);
CREATE INDEX ix_step_image_step_id ON step_image (step_id);
CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
