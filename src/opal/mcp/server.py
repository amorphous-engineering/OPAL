"""OPAL MCP Server implementation."""

import json
import logging
import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool
from sqlalchemy import func

from opal.api.routes.issues import _recheck_instance_completion
from opal.config import get_active_project, get_active_settings
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import (
    generate_designator,
    generate_issue_number,
    generate_requirement_number,
    generate_risk_number,
)
from opal.core.holds import get_holds_payload, holding_readout
from opal.core.numbering import (
    PartNumberError,
    next_part_number,
    peek_next_part_number,
    pn_exists,
    register_part_number,
)
from opal.core.part_lifecycle import (
    DraftPartsBlocked,
    PartLifecycleError,
    activate_part,
    draft_parts_in,
    ensure_parts_active,
)
from opal.db.base import LifecycleState, SessionLocal
from opal.db.models import (
    BOMLine,
    InventoryRecord,
    Issue,
    Kit,
    MasterProcedure,
    Part,
    PartRequirement,
    ProcedureOutput,
    ProcedureStep,
    ProcedureVersion,
    Purchase,
    PurchaseLine,
    Requirement,
    Risk,
    StepDependency,
    StepKit,
    Supplier,
    User,
    Workcenter,
)
from opal.db.models.issue import (
    Containment,
    DispositionType,
    IssuePriority,
    IssueStatus,
    IssueType,
)
from opal.db.models.part import TrackingType
from opal.db.models.procedure import ProcedureStatus, ProcedureType, UsageType
from opal.db.models.purchase import PurchaseStatus
from opal.db.models.risk import RiskDisposition, RiskIssueLink, RiskIssueRole
from opal.risks import dispositions as risk_dispositions
from opal.risks import lint as risk_lint
from opal.se import lint as se_lint

logger = logging.getLogger(__name__)

# Create MCP server
server = Server("opal")


def get_db():
    """Get a database session."""
    return SessionLocal()


def json_response(data: Any) -> list[TextContent]:
    """Create a JSON text response."""
    return [TextContent(type="text", text=json.dumps(data, indent=2, default=str))]


# Remedy named in draft_parts_blocked errors so agents resolve the blocker
# explicitly in-transcript rather than the system mutating state silently.
_MCP_DRAFT_REMEDY = (
    "call activate_part(part_id, user_id) for each draft part "
    "(or bulk_activate_parts), then retry this tool"
)


# ============ TOOLS ============


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List all available tools."""
    return [
        # Parts
        Tool(
            name="list_parts",
            description="List all parts in the system, optionally filtered by category",
            inputSchema={
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Filter by category (optional)",
                    },
                    "search": {
                        "type": "string",
                        "description": "Search term for name or part number (optional)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 50)",
                        "default": 50,
                    },
                },
            },
        ),
        Tool(
            name="get_part",
            description="Get details of a specific part by ID",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {
                        "type": "integer",
                        "description": "The part ID",
                    },
                },
                "required": ["part_id"],
            },
        ),
        Tool(
            name="create_part",
            description=(
                "Create a new part in the system. Parts are born draft "
                "(identity mutable); activation is a deliberate human act — "
                "agents create and structure drafts, a human activates via "
                "activate_part."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Part name",
                    },
                    "internal_pn": {
                        "type": "string",
                        "description": (
                            "Optional internal part number override; must match the "
                            "project numbering format (auto-generated if omitted)"
                        ),
                    },
                    "category": {
                        "type": "string",
                        "description": "Part category (e.g., propulsion, structures, avionics)",
                    },
                    "description": {
                        "type": "string",
                        "description": "Part description (optional)",
                    },
                    "external_pn": {
                        "type": "string",
                        "description": "External/manufacturer part number (optional)",
                    },
                    "unit_of_measure": {
                        "type": "string",
                        "description": "Unit of measure (default: each)",
                        "default": "each",
                    },
                    "tier": {
                        "type": "integer",
                        "description": (
                            "Inventory tier level, as configured in the project "
                            "(see get_project_info for the tier list). Default: 1"
                        ),
                        "default": 1,
                    },
                    "parent_id": {
                        "type": "integer",
                        "description": "Parent assembly ID (optional)",
                    },
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="get_part_tree",
            description="Get the part hierarchy tree starting from a part or all top-level parts",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {
                        "type": "integer",
                        "description": "Starting part ID (optional - if not provided, shows all top-level parts)",
                    },
                    "depth": {
                        "type": "integer",
                        "description": "Maximum depth to traverse (default: 3)",
                        "default": 3,
                    },
                },
            },
        ),
        Tool(
            name="get_part_consumption_history",
            description="Get detailed history of where a part was consumed (which procedure instances/steps)",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {
                        "type": "integer",
                        "description": "The part ID",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 20)",
                        "default": 20,
                    },
                },
                "required": ["part_id"],
            },
        ),
        # Procedures
        Tool(
            name="list_procedures",
            description="List all procedures in the system",
            inputSchema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Filter by status: draft, active, deprecated (optional)",
                    },
                    "search": {
                        "type": "string",
                        "description": "Search term for procedure name (optional)",
                    },
                },
            },
        ),
        Tool(
            name="create_procedure",
            description=(
                "Create a new master procedure template in draft status. "
                "procedure_type is 'op' (work order, no output) or 'build' "
                "(produces an assembly via ProcedureOutput). Status is always "
                "'draft' until published via the web UI / publish endpoint."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Procedure name",
                    },
                    "description": {
                        "type": "string",
                        "description": "Procedure description (optional)",
                    },
                    "procedure_type": {
                        "type": "string",
                        "enum": ["op", "build"],
                        "description": (
                            "'op' = work order with no part output (default); "
                            "'build' = produces an assembly. Outputs are configured "
                            "separately via the web UI / API."
                        ),
                        "default": "op",
                    },
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="add_procedure_step",
            description=(
                "Add a step (OP) to a draft procedure. Without parent_step_id, "
                "creates a top-level OP numbered 1, 2, 3... (or C1, C2, C3... if "
                "is_contingency=true). With parent_step_id, creates a sub-step "
                "numbered <parent>.<N> that inherits is_contingency from its "
                "parent. step_number, level, and order are calculated server-side "
                "and cannot be overridden."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {
                        "type": "integer",
                        "description": "The procedure ID",
                    },
                    "title": {
                        "type": "string",
                        "description": "Step title",
                    },
                    "instructions": {
                        "type": "string",
                        "description": "Step instructions (markdown supported)",
                    },
                    "parent_step_id": {
                        "type": "integer",
                        "description": (
                            "Parent OP ID. Omit for a top-level OP; set to create "
                            "a sub-step (level=1) under the given OP."
                        ),
                    },
                    "is_contingency": {
                        "type": "boolean",
                        "description": (
                            "Top-level only: mark as a contingency OP (numbered "
                            "C1, C2...) that runs only when an NC is logged. "
                            "Ignored for sub-steps — they inherit from their parent."
                        ),
                        "default": False,
                    },
                    "requires_signoff": {
                        "type": "boolean",
                        "description": "Step requires sign-off to complete (default false)",
                        "default": False,
                    },
                    "estimated_duration_minutes": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Estimated duration in minutes (optional)",
                    },
                    "required_role": {
                        "type": "string",
                        "description": "Role required for this step, e.g. QE (optional, informational badge)",
                    },
                    "caution": {
                        "type": "string",
                        "description": "Safety warning text displayed in red during execution (optional)",
                    },
                    "required_data_schema": {
                        "type": "object",
                        "description": (
                            "JSON schema describing data to capture at this step "
                            "(measurements, readings, etc). Optional."
                        ),
                    },
                },
                "required": ["procedure_id", "title"],
            },
        ),
        Tool(
            name="get_procedure",
            description=(
                "Get a procedure with its full hierarchical step tree, kit, "
                "outputs, dependencies, and current version pointer."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer", "description": "The procedure ID"},
                },
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="update_procedure",
            description=(
                "Update a procedure's metadata: name, description, status "
                "(draft/active/deprecated), or procedure_type (op/build). "
                "Note: published versions are immutable; this only edits the "
                "master template."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "status": {"type": "string", "enum": ["draft", "active", "deprecated"]},
                    "procedure_type": {"type": "string", "enum": ["op", "build"]},
                },
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="delete_procedure",
            description="Soft-delete a procedure (sets deleted_at). Audit-logged.",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                },
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="update_step",
            description=(
                "Update a step's title, instructions, is_contingency, "
                "requires_signoff, estimated_duration_minutes, required_role, "
                "caution, or required_data_schema. Step_number, level, parent, "
                "and order are not editable here — use reorder_steps for ordering."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "instructions": {"type": "string"},
                    "is_contingency": {"type": "boolean"},
                    "requires_signoff": {"type": "boolean"},
                    "estimated_duration_minutes": {"type": "integer", "minimum": 1},
                    "required_role": {"type": "string"},
                    "caution": {"type": "string"},
                    "required_data_schema": {"type": "object"},
                },
                "required": ["procedure_id", "step_id"],
            },
        ),
        Tool(
            name="delete_step",
            description=(
                "Hard-delete a step (and its sub-steps via cascade). Renumbers "
                "remaining steps so step_numbers stay contiguous (1, 2, 3..., "
                "C1, C2..., <parent>.N)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                },
                "required": ["procedure_id", "step_id"],
            },
        ),
        Tool(
            name="reorder_steps",
            description=(
                "Reorder every step in the procedure. step_ids must be the "
                "exact set of all current step IDs (including sub-steps) in "
                "the new global order. step_number labels are recomputed to "
                "match the new ordering."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "All step IDs of the procedure, in the new order.",
                    },
                },
                "required": ["procedure_id", "step_ids"],
            },
        ),
        Tool(
            name="list_step_dependencies",
            description=(
                "List all op-level prerequisite edges in a procedure as "
                "{step_id, depends_on_step_id} pairs. Dependencies only apply "
                "to top-level OPs (sub-steps inherit their parent's gating)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                },
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="set_step_dependencies",
            description=(
                "Replace the full prerequisite list for a top-level OP. "
                "Validates same-procedure scope, op-level only (no sub-steps "
                "on either side), no self-loops, and no cycles. Pass an empty "
                "depends_on to clear all prereqs for the step."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer", "description": "The dependent (gated) OP"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Step IDs that must complete before step_id can start.",
                    },
                },
                "required": ["procedure_id", "step_id", "depends_on"],
            },
        ),
        Tool(
            name="get_kit",
            description=(
                "Get the procedure-level Kit (Bill of Materials of parts that "
                "will be consumed by an execution of this procedure)."
            ),
            inputSchema={
                "type": "object",
                "properties": {"procedure_id": {"type": "integer"}},
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="add_kit_item",
            description=(
                "Add a part to the procedure-level Kit. Fails if the part is "
                "already on the kit (use update_kit_item to change quantity)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                    "quantity_required": {"type": "number", "exclusiveMinimum": 0},
                },
                "required": ["procedure_id", "part_id", "quantity_required"],
            },
        ),
        Tool(
            name="update_kit_item",
            description="Update a Kit item's required quantity.",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "kit_id": {"type": "integer"},
                    "quantity_required": {"type": "number", "exclusiveMinimum": 0},
                },
                "required": ["procedure_id", "kit_id", "quantity_required"],
            },
        ),
        Tool(
            name="remove_kit_item",
            description="Remove a part from the procedure-level Kit (by part_id).",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                },
                "required": ["procedure_id", "part_id"],
            },
        ),
        Tool(
            name="get_outputs",
            description=(
                "Get the output parts a build-type procedure produces. "
                "Returns [] for op-type procedures."
            ),
            inputSchema={
                "type": "object",
                "properties": {"procedure_id": {"type": "integer"}},
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="add_output",
            description=(
                "Add an output part (assembly produced) to a build-type "
                "procedure. Note: the canonical add-output handler also "
                "auto-populates the Kit from the part's BOMLine children; "
                "this tool does the same to stay consistent."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                    "quantity_produced": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "default": 1,
                    },
                },
                "required": ["procedure_id", "part_id"],
            },
        ),
        Tool(
            name="update_output",
            description="Update the quantity_produced for an output part (by part_id).",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                    "quantity_produced": {"type": "number", "exclusiveMinimum": 0},
                },
                "required": ["procedure_id", "part_id", "quantity_produced"],
            },
        ),
        Tool(
            name="remove_output",
            description="Remove an output part from a procedure (by part_id).",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                },
                "required": ["procedure_id", "part_id"],
            },
        ),
        Tool(
            name="get_step_kit",
            description=(
                "Get the parts required at a specific step (StepKit). Each "
                "item has a usage_type: 'consume' (inventory decremented at "
                "step completion) or 'tooling' (GSE/fixtures, returned)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                },
                "required": ["procedure_id", "step_id"],
            },
        ),
        Tool(
            name="add_step_kit_item",
            description="Add a part to a step's kit.",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                    "quantity_required": {"type": "number", "exclusiveMinimum": 0},
                    "usage_type": {
                        "type": "string",
                        "enum": ["consume", "tooling"],
                        "default": "consume",
                    },
                    "notes": {"type": "string"},
                },
                "required": ["procedure_id", "step_id", "part_id", "quantity_required"],
            },
        ),
        Tool(
            name="update_step_kit_item",
            description="Update a step kit item's quantity, usage_type, or notes.",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                    "step_kit_id": {"type": "integer"},
                    "quantity_required": {"type": "number", "exclusiveMinimum": 0},
                    "usage_type": {"type": "string", "enum": ["consume", "tooling"]},
                    "notes": {"type": "string"},
                },
                "required": ["procedure_id", "step_id", "step_kit_id"],
            },
        ),
        Tool(
            name="remove_step_kit_item",
            description="Remove a part from a step's kit (by part_id).",
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "step_id": {"type": "integer"},
                    "part_id": {"type": "integer"},
                },
                "required": ["procedure_id", "step_id", "part_id"],
            },
        ),
        Tool(
            name="publish_version",
            description=(
                "Publish the current draft as a new immutable ProcedureVersion "
                "snapshot. Bumps current_version_id and flips status to "
                "'active'. Fails if the procedure has no steps. Snapshot "
                "includes steps (with hierarchy), step kits, dependencies "
                "(emitted as prereq `order` values for execution lookup), "
                "procedure kit, and outputs."
            ),
            inputSchema={
                "type": "object",
                "properties": {"procedure_id": {"type": "integer"}},
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="list_versions",
            description="List all published versions of a procedure (newest first).",
            inputSchema={
                "type": "object",
                "properties": {"procedure_id": {"type": "integer"}},
                "required": ["procedure_id"],
            },
        ),
        Tool(
            name="clone_procedure",
            description=(
                "Clone a procedure into a new draft. Copies all steps "
                "(hierarchy preserved). Step kits, procedure kit, and outputs "
                "are copied conditionally. The clone starts at version 0 in "
                "draft status."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "procedure_id": {"type": "integer"},
                    "new_name": {
                        "type": "string",
                        "description": "Optional new name (default: 'Copy of <source name>')",
                    },
                    "copy_kit": {"type": "boolean", "default": True},
                    "copy_outputs": {"type": "boolean", "default": True},
                },
                "required": ["procedure_id"],
            },
        ),
        # Issues
        Tool(
            name="list_issues",
            description="List issues, optionally filtered by status, disposition state, or type",
            inputSchema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Filter by status: open, closed",
                    },
                    "disp_state": {
                        "type": "string",
                        "enum": ["open", "undispositioned", "dispositioned", "closed"],
                        "description": (
                            "Filter by state: open (advisory-open), undispositioned, "
                            "dispositioned (containment-bearing only), closed"
                        ),
                    },
                    "issue_type": {
                        "type": "string",
                        "description": "Filter by type: bug, task, improvement, non_conformance",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 50)",
                        "default": 50,
                    },
                },
            },
        ),
        Tool(
            name="raise_issue",
            description=(
                "Raise an issue (problem, task, improvement, or non-conformance). "
                "Containment declares what the issue holds while undispositioned: "
                "step | op | wo | advisory (default advisory; execution-raised "
                "issues should use step and set raised_step_id)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Issue title",
                    },
                    "description": {
                        "type": "string",
                        "description": "Issue description (optional)",
                    },
                    "issue_type": {
                        "type": "string",
                        "description": "Type: bug, task, improvement, non_conformance (default: task)",
                        "default": "task",
                    },
                    "priority": {
                        "type": "string",
                        "description": "Priority: low, medium, high, critical (default: medium)",
                        "default": "medium",
                    },
                    "containment": {
                        "type": "string",
                        "description": "What this issue holds while undispositioned: step, op, wo, advisory (default: advisory)",
                        "default": "advisory",
                    },
                    "should_be": {
                        "type": "string",
                        "description": "Expected condition (the NC pair, captured at discovery)",
                    },
                    "actual": {
                        "type": "string",
                        "description": "Actual condition",
                    },
                    "procedure_instance_id": {
                        "type": "integer",
                        "description": "Work order this issue belongs to (required for non-advisory containment)",
                    },
                    "raised_step_id": {
                        "type": "integer",
                        "description": "Step execution ID where it was found",
                    },
                    "containment_step_id": {
                        "type": "integer",
                        "description": "Boundary step execution ID ('resolve by 3.7'); blocks that step's START",
                    },
                    "part_id": {"type": "integer"},
                    "assigned_to_id": {"type": "integer"},
                    "user_id": {
                        "type": "integer",
                        "description": "Human user raising the issue",
                    },
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="sign_disposition",
            description=(
                "Sign an issue's disposition — the signature releases every "
                "containment the issue holds, immediately. user_id must be the "
                "human making the decision."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "issue_id": {"type": "integer"},
                    "user_id": {
                        "type": "integer",
                        "description": "Human user signing the disposition",
                    },
                    "disposition_type": {
                        "type": "string",
                        "description": "use_as_is, rework, repair, scrap, return_to_supplier, no_defect",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "Disposition rationale",
                    },
                },
                "required": ["issue_id", "user_id", "disposition_type", "rationale"],
            },
        ),
        Tool(
            name="set_containment",
            description=(
                "Change an issue's containment scope. Narrowing (e.g. op → step, "
                "or anything → advisory) releases a hold and requires a note, "
                "which is recorded on the issue."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "issue_id": {"type": "integer"},
                    "containment": {
                        "type": "string",
                        "description": "step, op, wo, advisory",
                    },
                    "containment_step_id": {"type": "integer"},
                    "note": {
                        "type": "string",
                        "description": "Required when narrowing scope",
                    },
                    "user_id": {"type": "integer"},
                },
                "required": ["issue_id", "containment"],
            },
        ),
        Tool(
            name="get_holds",
            description=(
                "Blocking state for a work order: every undispositioned issue "
                "holding it and what each blocks (are we held and why)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "execution_id": {
                        "type": "integer",
                        "description": "Procedure instance (work order) ID",
                    },
                },
                "required": ["execution_id"],
            },
        ),
        # Risks
        Tool(
            name="list_risks",
            description=(
                "List risks, optionally filtered by disposition or severity. "
                "Each row carries the generated scenario statement, current and "
                "residual scores, and owner. Agents draft scenarios; acceptance "
                "is a human signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "disposition": {
                        "type": "string",
                        "description": (
                            "Filter by disposition: open, mitigate, watch, "
                            "research, accepted, closed, realized"
                        ),
                    },
                    "severity": {
                        "type": "string",
                        "description": "Filter by severity: low, medium, high",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 50)",
                        "default": 50,
                    },
                },
            },
        ),
        Tool(
            name="create_risk",
            description=(
                "Create a risk as a four-part scenario: 'Given that CONDITION, "
                "there is a possibility of DEPARTURE adversely impacting ASSET, "
                "thereby leading to CONSEQUENCE.' The prose statement is "
                "generated from the parts, never stored. The asset is "
                "asset_part_id (hardware) or asset_text (schedule, budget, ...) "
                "— exactly one. The risk is born with disposition open; use "
                "set_risk_disposition / link_risk_issue afterwards. Agents draft "
                "scenarios; acceptance is a human signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short handle for the risk",
                    },
                    "description": {
                        "type": "string",
                        "description": (
                            "Narrative: context, evidence, suggested responses (optional)"
                        ),
                    },
                    "condition": {
                        "type": "string",
                        "description": "Present-tense fact, independently checkable now",
                    },
                    "departure": {
                        "type": "string",
                        "description": "Undesired future event — probability scores this",
                    },
                    "asset_part_id": {
                        "type": "integer",
                        "description": (
                            "Exposed asset when it is hardware (exclusive with asset_text)"
                        ),
                    },
                    "asset_text": {
                        "type": "string",
                        "description": (
                            'Exposed asset when not hardware, e.g. "schedule" '
                            "(exclusive with asset_part_id)"
                        ),
                    },
                    "consequence": {
                        "type": "string",
                        "description": "Credible measurable impact — impact scores this",
                    },
                    "owner_id": {
                        "type": "integer",
                        "description": "Owning user ID (optional; required before acceptance)",
                    },
                    "probability": {
                        "type": "integer",
                        "description": "Probability score 1-5 (1=rare, 5=almost certain)",
                        "minimum": 1,
                        "maximum": 5,
                    },
                    "impact": {
                        "type": "integer",
                        "description": "Impact score 1-5 (1=negligible, 5=catastrophic)",
                        "minimum": 1,
                        "maximum": 5,
                    },
                    "residual_probability": {
                        "type": "integer",
                        "description": "Post-response target probability 1-5 (optional)",
                        "minimum": 1,
                        "maximum": 5,
                    },
                    "residual_impact": {
                        "type": "integer",
                        "description": "Post-response target impact 1-5 (optional)",
                        "minimum": 1,
                        "maximum": 5,
                    },
                    "watch_observable": {
                        "type": "string",
                        "description": "What is being monitored (watch disposition)",
                    },
                    "watch_threshold": {
                        "type": "string",
                        "description": "When the watch trips (watch disposition)",
                    },
                    "watch_contingency": {
                        "type": "string",
                        "description": "What happens when the watch trips (optional)",
                    },
                },
                "required": ["title", "probability", "impact"],
            },
        ),
        Tool(
            name="lint_risk",
            description=(
                "Lint a risk scenario for statement discipline: speculation "
                "words in the condition (blocks acceptance), response language "
                "in departure/consequence, unmeasurable consequence (warnings). "
                "Pass risk_id or risk_number to lint a stored risk, or raw "
                "condition/departure/consequence to pre-check text before "
                "creating. Agents draft scenarios; acceptance is a human "
                "signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "risk_id": {"type": "integer", "description": "Database ID"},
                    "risk_number": {
                        "type": "string",
                        "description": "Risk number, e.g. RISK-00001",
                    },
                    "condition": {
                        "type": "string",
                        "description": "Ad-hoc condition text to lint",
                    },
                    "departure": {
                        "type": "string",
                        "description": "Ad-hoc departure text to lint",
                    },
                    "consequence": {
                        "type": "string",
                        "description": "Ad-hoc consequence text to lint",
                    },
                },
            },
        ),
        Tool(
            name="set_risk_disposition",
            description=(
                "Transition a risk's disposition: open, mitigate, watch, "
                "research, closed, realized. Each target names its "
                "requirements — mitigate needs an open mitigation-role issue "
                "link and a residual score; watch needs an observable and a "
                "threshold; research needs a research-role link or a narrative; "
                "closed needs a note; realized needs realized_issue_id and is "
                "terminal. accepted is NOT reachable here — use accept_risk: "
                "acceptance is a human signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "risk_id": {"type": "integer", "description": "Database ID"},
                    "risk_number": {
                        "type": "string",
                        "description": "Risk number, e.g. RISK-00001",
                    },
                    "disposition": {
                        "type": "string",
                        "description": (
                            "Target disposition: open, mitigate, watch, research, closed, realized"
                        ),
                    },
                    "note": {
                        "type": "string",
                        "description": (
                            "Transition note — required to close or to leave accepted; "
                            "recorded in the audit trail"
                        ),
                    },
                    "realized_issue_id": {
                        "type": "integer",
                        "description": (
                            "Issue the departure became — set before transitioning to realized"
                        ),
                    },
                    "user_id": {
                        "type": "integer",
                        "description": "Acting user ID for the audit trail (optional)",
                    },
                },
                "required": ["disposition"],
            },
        ),
        Tool(
            name="accept_risk",
            description=(
                "Accept a risk — the signature moment. Agents draft scenarios "
                "and link mitigations; acceptance is a human signature. Requires "
                "the user_id of a real, active human user who approved the "
                "acceptance; refuses unless the scenario is complete, owned, "
                "scored, lint-clean, and a rationale is recorded."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "risk_id": {"type": "integer", "description": "Database ID"},
                    "risk_number": {
                        "type": "string",
                        "description": "Risk number, e.g. RISK-00001",
                    },
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user signing the acceptance (required)",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "Acceptance rationale (stored on the risk)",
                    },
                },
                "required": ["user_id"],
            },
        ),
        Tool(
            name="link_risk_issue",
            description=(
                "Link an existing issue to a risk as a response. role "
                "mitigation = reduction work (a mitigation is real when it has "
                "an issue with an owner); role research = uncertainty-reduction "
                "work. Agents link mitigations; acceptance is a human signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "risk_id": {"type": "integer", "description": "Risk database ID"},
                    "risk_number": {
                        "type": "string",
                        "description": "Risk number, e.g. RISK-00001",
                    },
                    "issue_id": {"type": "integer", "description": "Issue database ID"},
                    "issue_number": {
                        "type": "string",
                        "description": "Issue number, e.g. ISS-00012",
                    },
                    "role": {
                        "type": "string",
                        "description": "mitigation or research (default mitigation)",
                        "default": "mitigation",
                    },
                },
            },
        ),
        Tool(
            name="stamp_risk_review",
            description=(
                "Stamp last_reviewed on risks — the register review ceremony. "
                "Omit risk_ids to stamp every non-deleted risk. Requires the "
                "user_id of the human who performed the review; agents prepare "
                "the register, humans review it."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user who performed the review (required)",
                    },
                    "risk_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Risk IDs to stamp (omit to stamp all non-deleted risks)",
                    },
                },
                "required": ["user_id"],
            },
        ),
        # Project info
        Tool(
            name="get_project_info",
            description=(
                "Get information about the current OPAL project including the "
                "connected database URL, tiers, requirements, and part numbering "
                "config. Call this first to confirm which database you are "
                "operating on — report its path when asked to verify data."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="preview_part_number",
            description=(
                "Preview a part number for a tier. Without 'sequence', returns "
                "the actual next number that would be assigned (without "
                "consuming it); with 'sequence', formats that specific number."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "tier": {
                        "type": "integer",
                        "description": "Tier level (1, 2, or 3)",
                    },
                    "sequence": {
                        "type": "integer",
                        "description": "Sequence number (optional — omit to preview the next)",
                    },
                },
                "required": ["tier"],
            },
        ),
        Tool(
            name="activate_part",
            description=(
                "Activate a draft part, locking its identity (internal_pn, tier) "
                "permanently. POLICY: agents draft, humans activate — requires "
                "the user_id of a real human user who approved the activation."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {"type": "integer", "description": "The part ID"},
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user approving the activation",
                    },
                    "cause": {
                        "type": "string",
                        "description": "Why the identity is locking (recorded in the audit trail)",
                    },
                },
                "required": ["part_id", "user_id"],
            },
        ),
        Tool(
            name="bulk_activate_parts",
            description=(
                "Activate multiple draft parts in one signed act (e.g. import a "
                "CAD tree as drafts, then bulk-activate the already-built "
                "subset). Skips parts that are already active, reporting each. "
                "POLICY: agents draft, humans activate — requires a real "
                "human user_id."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "part_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "IDs of the parts to activate",
                    },
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user approving the activation",
                    },
                    "cause": {
                        "type": "string",
                        "description": "Why these identities are locking (recorded per part)",
                    },
                },
                "required": ["part_ids", "user_id"],
            },
        ),
        Tool(
            name="reserve_part_numbers",
            description=(
                "Reserve a block of part numbers by creating real draft rows "
                "(named {name_prefix}-{sequence}). Serves label pre-printing "
                "and vendor pre-allocation; unused reservations are visibly "
                "stale drafts a human can delete — their numbers never reissue."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "tier": {"type": "integer", "default": 1, "description": "Tier level"},
                    "count": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "description": "How many numbers to reserve",
                    },
                    "name_prefix": {
                        "type": "string",
                        "description": "Name prefix for the draft rows (default: RESERVED)",
                    },
                },
                "required": ["count"],
            },
        ),
        # Requirements
        Tool(
            name="list_requirements",
            description=(
                "List first-class requirements (REQ-XXXX). Superseded revisions "
                "are hidden unless include_superseded=true."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "state": {
                        "type": "string",
                        "enum": ["draft", "preliminary", "baselined", "superseded", "cancelled"],
                        "description": "Filter by lifecycle state (optional)",
                    },
                    "level": {"type": "integer", "description": "Filter by flow-down level"},
                    "query": {
                        "type": "string",
                        "description": "Substring match on number, title, or statement",
                    },
                    "include_superseded": {"type": "boolean", "default": False},
                    "limit": {"type": "integer", "default": 50},
                },
            },
        ),
        Tool(
            name="get_requirement",
            description=(
                "Get a requirement by ID or REQ number, with children, part "
                "allocations, and its revision chain."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer", "description": "Database ID"},
                    "req_number": {
                        "type": "string",
                        "description": "REQ number, e.g. REQ-0042 (latest non-superseded revision)",
                    },
                },
            },
        ),
        Tool(
            name="create_requirement",
            description=(
                "Create a new draft requirement. The REQ number is auto-assigned. "
                "Statement should be a single shall statement; rationale is "
                "required before the requirement can be baselined. The response "
                "includes lint findings — resolve block_baseline ones before "
                "requesting baseline."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short name"},
                    "statement": {"type": "string", "description": "The shall statement"},
                    "rationale": {"type": "string", "description": "Why this requirement exists"},
                    "category": {
                        "type": "string",
                        "description": "functional, performance, interface, environmental, safety, ...",
                    },
                    "parent_id": {
                        "type": "integer",
                        "description": "Parent requirement ID for flow-down (level defaults to parent+1)",
                    },
                    "level": {
                        "type": "integer",
                        "description": "0=mission, 1=system, 2=subsystem...",
                    },
                    "verification_method": {
                        "type": "string",
                        "enum": ["analysis", "inspection", "demonstration", "test"],
                    },
                    "tbd": {"type": "boolean", "default": False},
                    "tbr": {"type": "boolean", "default": False},
                },
                "required": ["title", "statement"],
            },
        ),
        Tool(
            name="update_requirement",
            description=(
                "Update a draft/preliminary requirement in place. Baselined "
                "requirements are immutable — use revise_requirement instead."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "statement": {"type": "string"},
                    "rationale": {"type": "string"},
                    "category": {"type": "string"},
                    "parent_id": {"type": "integer"},
                    "level": {"type": "integer"},
                    "verification_method": {
                        "type": "string",
                        "enum": ["analysis", "inspection", "demonstration", "test"],
                    },
                    "tbd": {"type": "boolean"},
                    "tbr": {"type": "boolean"},
                },
                "required": ["requirement_id"],
            },
        ),
        Tool(
            name="baseline_requirement",
            description=(
                "Baseline a requirement, locking it as immutable. POLICY: agents "
                "draft, humans baseline — this requires the user_id of a real "
                "human user who has approved the baseline. Fails listing the "
                "blockers if the requirement is not ready (missing rationale, "
                "unresolved TBD, TBR without owner/due date)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user approving the baseline (required)",
                    },
                },
                "required": ["requirement_id", "user_id"],
            },
        ),
        Tool(
            name="get_baseline_queue",
            description=(
                "The baseline-ready set: draft/preliminary requirements whose "
                "hard readiness checks all pass. Agents stage analysis for the "
                "queue; a human commits it via baseline_batch."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="baseline_batch",
            description=(
                "Baseline a set of requirements atomically and write one "
                "baseline event. POLICY: agents draft, humans baseline — "
                "user_id must belong to a real human user who approved the "
                "batch. Every item is re-validated at commit time; any "
                "failure aborts the whole batch and returns the offenders."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Requirement IDs to baseline",
                    },
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user approving the batch (required)",
                    },
                    "label": {
                        "type": "string",
                        "description": "Optional event label, e.g. l0-freeze",
                    },
                    "note": {"type": "string"},
                },
                "required": ["ids", "user_id"],
            },
        ),
        Tool(
            name="get_baseline_events",
            description=(
                "Baseline events history (newest first): who locked which "
                "requirement revisions, when, under what label."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "event_id": {
                        "type": "integer",
                        "description": "Return just this event with its locked set",
                    },
                },
            },
        ),
        Tool(
            name="revise_requirement",
            description=(
                "Create the next draft revision of a baselined requirement "
                "(same REQ number, revision + 1). The old revision stays the "
                "effective baseline until the new one is baselined."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                },
                "required": ["requirement_id"],
            },
        ),
        Tool(
            name="reaffirm_requirement",
            description=(
                "Clear a requirement's stale flag without editing it — 'the "
                "parent's change doesn't invalidate this'. POLICY: signature "
                "act, requires the user_id of a real human user. Staleness is "
                "set on direct children when their parent's revision "
                "supersedes; it also clears on any edit."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                    "user_id": {
                        "type": "integer",
                        "description": "ID of the human user re-affirming (required)",
                    },
                },
                "required": ["requirement_id", "user_id"],
            },
        ),
        Tool(
            name="get_requirement_diff",
            description=(
                "Word-level diff of statement and rationale between two "
                "revisions of a requirement. Defaults to this revision vs "
                "the one it supersedes."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                    "req_number": {"type": "string"},
                    "rev_a": {"type": "integer", "description": "Older revision number"},
                    "rev_b": {"type": "integer", "description": "Newer revision number"},
                },
            },
        ),
        Tool(
            name="cancel_requirement",
            description="Cancel a requirement (terminal state).",
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer"},
                },
                "required": ["requirement_id"],
            },
        ),
        Tool(
            name="lint_requirement",
            description=(
                "Lint a requirement against the SP-6105 Appendix C automatable "
                "subset. Pass requirement_id or req_number to lint a stored row, "
                "or statement (+ optional fields) to pre-check text before "
                "creating. block_baseline findings prevent baselining; warns are "
                "advisory."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {"type": "integer", "description": "Database ID"},
                    "req_number": {"type": "string", "description": "REQ number, e.g. REQ-0042"},
                    "statement": {
                        "type": "string",
                        "description": "Ad-hoc shall statement to lint instead of a stored row",
                    },
                    "rationale": {"type": "string"},
                    "verification_method": {"type": "string"},
                    "tbd": {"type": "boolean"},
                    "tbr": {"type": "boolean"},
                },
            },
        ),
        Tool(
            name="flowdown_tree",
            description=(
                "Requirement flow-down hierarchy as a nested tree (parent -> "
                "derived children). No arguments returns all roots. Superseded "
                "and deleted revisions are excluded; requirements whose parent "
                "is excluded surface as orphan roots."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "requirement_id": {
                        "type": "integer",
                        "description": "Root the tree at this requirement",
                    },
                    "req_number": {"type": "string", "description": "Root at this REQ number"},
                },
            },
        ),
        Tool(
            name="list_part_requirements",
            description="List all requirements assigned to a part",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {
                        "type": "integer",
                        "description": "The part ID",
                    },
                },
                "required": ["part_id"],
            },
        ),
        Tool(
            name="assign_requirement",
            description="Assign a project requirement to a part",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {
                        "type": "integer",
                        "description": "The part ID",
                    },
                    "requirement_id": {
                        "type": "string",
                        "description": "The requirement ID (e.g., REQ-001)",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Notes about this requirement assignment (optional)",
                    },
                },
                "required": ["part_id", "requirement_id"],
            },
        ),
        Tool(
            name="verify_requirement",
            description="Mark a part requirement as verified",
            inputSchema={
                "type": "object",
                "properties": {
                    "part_requirement_id": {
                        "type": "integer",
                        "description": "The part requirement record ID",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Verification notes (optional)",
                    },
                },
                "required": ["part_requirement_id"],
            },
        ),
        # BOM / Assembly
        Tool(
            name="get_bom",
            description="Get the Bill of Materials (BOM) for an assembly",
            inputSchema={
                "type": "object",
                "properties": {
                    "assembly_id": {
                        "type": "integer",
                        "description": "The assembly part ID",
                    },
                },
                "required": ["assembly_id"],
            },
        ),
        Tool(
            name="add_component",
            description="Add a component to an assembly's BOM",
            inputSchema={
                "type": "object",
                "properties": {
                    "assembly_id": {
                        "type": "integer",
                        "description": "The assembly part ID",
                    },
                    "component_id": {
                        "type": "integer",
                        "description": "The component part ID to add",
                    },
                    "quantity": {
                        "type": "integer",
                        "description": "Quantity of this component (default: 1)",
                        "default": 1,
                    },
                    "reference_designator": {
                        "type": "string",
                        "description": "Reference designator (e.g., R1, C3) (optional)",
                    },
                },
                "required": ["assembly_id", "component_id"],
            },
        ),
        Tool(
            name="remove_component",
            description="Remove a component from an assembly's BOM",
            inputSchema={
                "type": "object",
                "properties": {
                    "bom_line_id": {
                        "type": "integer",
                        "description": "The BOM line ID to remove",
                    },
                },
                "required": ["bom_line_id"],
            },
        ),
        # Suppliers
        Tool(
            name="search_suppliers",
            description=(
                "Search suppliers by name substring. Returns matching active "
                "(non-deleted) suppliers with id, name, code, website, email, "
                "and is_active."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Name substring filter (optional)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 20)",
                        "default": 20,
                    },
                },
            },
        ),
        Tool(
            name="create_supplier",
            description="Create a new supplier/vendor record.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Supplier name"},
                    "code": {
                        "type": "string",
                        "description": "Short code, e.g. SUP-001 (optional)",
                    },
                    "website": {"type": "string"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                    "address": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["name"],
            },
        ),
        # Workcenters
        Tool(
            name="create_workcenter",
            description=(
                "Create a new workcenter (work location). A unique code is "
                "required; if omitted, one is derived from the name."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Workcenter name"},
                    "code": {
                        "type": "string",
                        "description": "Short unique code, e.g. AB1 (optional, derived from name if omitted)",
                    },
                    "description": {"type": "string"},
                    "location": {"type": "string", "description": "Physical location (optional)"},
                },
                "required": ["name"],
            },
        ),
        # Inventory
        Tool(
            name="get_inventory_summary",
            description=(
                "Get current stock summary for a part: total quantity on hand, "
                "record count, breakdown by location, and (for tooling parts) "
                "calibration status."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "part_id": {"type": "integer", "description": "The part ID"},
                },
                "required": ["part_id"],
            },
        ),
        # Bulk parts
        Tool(
            name="bulk_create_parts",
            description=(
                "Create multiple parts in one transaction. Each entry follows "
                "the same schema as create_part. Returns the created parts "
                "with their assigned internal_pn values. Parts are born draft; "
                "activation is a deliberate human act (activate_part / "
                "bulk_activate_parts)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "parts": {
                        "type": "array",
                        "description": "List of part objects to create",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "internal_pn": {
                                    "type": "string",
                                    "description": (
                                        "Optional PN override; must match the project "
                                        "numbering format"
                                    ),
                                },
                                "category": {"type": "string"},
                                "tier": {"type": "integer", "default": 1},
                                "tracking_type": {
                                    "type": "string",
                                    "enum": ["serialized", "bulk"],
                                    "default": "serialized",
                                },
                                "unit_of_measure": {"type": "string", "default": "each"},
                                "description": {"type": "string"},
                                "external_pn": {"type": "string"},
                                "reorder_point": {"type": "number"},
                                "parent_id": {"type": "integer"},
                            },
                            "required": ["name"],
                        },
                    },
                },
                "required": ["parts"],
            },
        ),
        # Purchase orders
        Tool(
            name="create_purchase_order",
            description=(
                "Create a purchase order with one or more line items. A PO "
                "reference (PO-NNNN) is auto-generated. Starts in 'draft' status."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "supplier_id": {"type": "integer", "description": "Supplier ID"},
                    "notes": {"type": "string"},
                    "lines": {
                        "type": "array",
                        "description": "Line items",
                        "items": {
                            "type": "object",
                            "properties": {
                                "part_id": {"type": "integer"},
                                "quantity": {"type": "number", "exclusiveMinimum": 0},
                                "unit_cost": {"type": "number"},
                                "notes": {"type": "string"},
                            },
                            "required": ["part_id", "quantity"],
                        },
                    },
                },
                "required": ["supplier_id", "lines"],
            },
        ),
        # Composite procedure build
        Tool(
            name="build_procedure",
            description=(
                "Create a complete procedure with all steps, step kits, "
                "procedure-level kit items, and outputs in a single call. "
                "Equivalent to create_procedure + add_procedure_step (xN) + "
                "add_step_kit_item (xN) + add_kit_item (xN) + add_output (xN)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Procedure name"},
                    "procedure_type": {
                        "type": "string",
                        "enum": ["op", "build"],
                        "default": "op",
                    },
                    "description": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "description": "Ordered list of top-level steps (OPs)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "instructions": {"type": "string"},
                                "required_role": {"type": "string"},
                                "caution": {"type": "string"},
                                "requires_signoff": {"type": "boolean", "default": False},
                                "estimated_duration_minutes": {"type": "integer", "minimum": 1},
                                "workcenter_id": {"type": "integer"},
                                "step_kits": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "part_id": {"type": "integer"},
                                            "quantity_required": {
                                                "type": "number",
                                                "exclusiveMinimum": 0,
                                            },
                                            "usage_type": {
                                                "type": "string",
                                                "enum": ["consume", "tooling"],
                                                "default": "consume",
                                            },
                                        },
                                        "required": ["part_id", "quantity_required"],
                                    },
                                },
                            },
                            "required": ["title"],
                        },
                    },
                    "kit": {
                        "type": "array",
                        "description": "Procedure-level kit items",
                        "items": {
                            "type": "object",
                            "properties": {
                                "part_id": {"type": "integer"},
                                "quantity_required": {"type": "number", "exclusiveMinimum": 0},
                            },
                            "required": ["part_id", "quantity_required"],
                        },
                    },
                    "outputs": {
                        "type": "array",
                        "description": "Output parts produced (build-type procedures)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "part_id": {"type": "integer"},
                                "quantity_produced": {
                                    "type": "number",
                                    "exclusiveMinimum": 0,
                                    "default": 1,
                                },
                            },
                            "required": ["part_id"],
                        },
                    },
                },
                "required": ["name"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    db = get_db()
    try:
        # Parts
        if name == "list_parts":
            return await _list_parts(db, arguments)
        elif name == "get_part":
            return await _get_part(db, arguments)
        elif name == "create_part":
            return await _create_part(db, arguments)
        elif name == "get_part_tree":
            return await _get_part_tree(db, arguments)
        elif name == "get_part_consumption_history":
            return await _get_part_consumption_history(db, arguments)

        # Procedures
        elif name == "list_procedures":
            return await _list_procedures(db, arguments)
        elif name == "get_procedure":
            return await _get_procedure(db, arguments)
        elif name == "create_procedure":
            return await _create_procedure(db, arguments)
        elif name == "update_procedure":
            return await _update_procedure(db, arguments)
        elif name == "delete_procedure":
            return await _delete_procedure(db, arguments)
        elif name == "add_procedure_step":
            return await _add_procedure_step(db, arguments)
        elif name == "update_step":
            return await _update_step(db, arguments)
        elif name == "delete_step":
            return await _delete_step(db, arguments)
        elif name == "reorder_steps":
            return await _reorder_steps(db, arguments)
        elif name == "list_step_dependencies":
            return await _list_step_dependencies(db, arguments)
        elif name == "set_step_dependencies":
            return await _set_step_dependencies(db, arguments)
        elif name == "get_kit":
            return await _get_kit(db, arguments)
        elif name == "add_kit_item":
            return await _add_kit_item(db, arguments)
        elif name == "update_kit_item":
            return await _update_kit_item(db, arguments)
        elif name == "remove_kit_item":
            return await _remove_kit_item(db, arguments)
        elif name == "get_outputs":
            return await _get_outputs(db, arguments)
        elif name == "add_output":
            return await _add_output(db, arguments)
        elif name == "update_output":
            return await _update_output(db, arguments)
        elif name == "remove_output":
            return await _remove_output(db, arguments)
        elif name == "get_step_kit":
            return await _get_step_kit(db, arguments)
        elif name == "add_step_kit_item":
            return await _add_step_kit_item(db, arguments)
        elif name == "update_step_kit_item":
            return await _update_step_kit_item(db, arguments)
        elif name == "remove_step_kit_item":
            return await _remove_step_kit_item(db, arguments)
        elif name == "publish_version":
            return await _publish_version(db, arguments)
        elif name == "list_versions":
            return await _list_versions(db, arguments)
        elif name == "clone_procedure":
            return await _clone_procedure(db, arguments)

        # Issues
        elif name == "list_issues":
            return await _list_issues(db, arguments)
        elif name in ("raise_issue", "create_issue"):
            return await _raise_issue(db, arguments)
        elif name == "sign_disposition":
            return await _sign_disposition(db, arguments)
        elif name == "set_containment":
            return await _set_containment(db, arguments)
        elif name == "get_holds":
            return await _get_holds(db, arguments)

        # Risks
        elif name == "list_risks":
            return await _list_risks(db, arguments)
        elif name == "create_risk":
            return await _create_risk(db, arguments)
        elif name == "lint_risk":
            return await _lint_risk(db, arguments)
        elif name == "set_risk_disposition":
            return await _set_risk_disposition(db, arguments)
        elif name == "accept_risk":
            return await _accept_risk(db, arguments)
        elif name == "link_risk_issue":
            return await _link_risk_issue(db, arguments)
        elif name == "stamp_risk_review":
            return await _stamp_risk_review(db, arguments)

        # Project
        elif name == "get_project_info":
            return await _get_project_info(db, arguments)
        elif name == "preview_part_number":
            return await _preview_part_number(db, arguments)
        elif name == "activate_part":
            return await _activate_part(db, arguments)
        elif name == "bulk_activate_parts":
            return await _bulk_activate_parts(db, arguments)
        elif name == "reserve_part_numbers":
            return await _reserve_part_numbers(db, arguments)

        # Requirements
        elif name == "list_requirements":
            return await _list_requirements(db, arguments)
        elif name == "get_requirement":
            return await _get_requirement(db, arguments)
        elif name == "create_requirement":
            return await _create_requirement(db, arguments)
        elif name == "update_requirement":
            return await _update_requirement(db, arguments)
        elif name == "baseline_requirement":
            return await _baseline_requirement(db, arguments)
        elif name == "get_baseline_queue":
            return await _get_baseline_queue(db, arguments)
        elif name == "baseline_batch":
            return await _baseline_batch(db, arguments)
        elif name == "get_baseline_events":
            return await _get_baseline_events(db, arguments)
        elif name == "revise_requirement":
            return await _revise_requirement(db, arguments)
        elif name == "cancel_requirement":
            return await _cancel_requirement(db, arguments)
        elif name == "reaffirm_requirement":
            return await _reaffirm_requirement(db, arguments)
        elif name == "get_requirement_diff":
            return await _get_requirement_diff(db, arguments)
        elif name == "lint_requirement":
            return await _lint_requirement(db, arguments)
        elif name == "flowdown_tree":
            return await _flowdown_tree(db, arguments)
        elif name == "list_part_requirements":
            return await _list_part_requirements(db, arguments)
        elif name == "assign_requirement":
            return await _assign_requirement(db, arguments)
        elif name == "verify_requirement":
            return await _verify_requirement(db, arguments)

        # BOM
        elif name == "get_bom":
            return await _get_bom(db, arguments)
        elif name == "add_component":
            return await _add_component(db, arguments)
        elif name == "remove_component":
            return await _remove_component(db, arguments)

        # Suppliers
        elif name == "search_suppliers":
            return await _search_suppliers(db, arguments)
        elif name == "create_supplier":
            return await _create_supplier(db, arguments)

        # Workcenters
        elif name == "create_workcenter":
            return await _create_workcenter(db, arguments)

        # Inventory
        elif name == "get_inventory_summary":
            return await _get_inventory_summary(db, arguments)

        # Bulk parts
        elif name == "bulk_create_parts":
            return await _bulk_create_parts(db, arguments)

        # Purchase orders
        elif name == "create_purchase_order":
            return await _create_purchase_order(db, arguments)

        # Composite procedure build
        elif name == "build_procedure":
            return await _build_procedure(db, arguments)

        else:
            return json_response({"error": f"Unknown tool: {name}"})
    finally:
        db.close()


# ============ TOOL IMPLEMENTATIONS ============


async def _list_parts(db, args: dict) -> list[TextContent]:
    """List parts with optional filtering."""
    query = db.query(Part).filter(Part.deleted_at.is_(None))

    if args.get("category"):
        query = query.filter(Part.category == args["category"])

    if args.get("search"):
        search = f"%{args['search']}%"
        query = query.filter(
            (Part.name.ilike(search))
            | (Part.internal_pn.ilike(search))
            | (Part.external_pn.ilike(search))
        )

    limit = args.get("limit", 50)
    parts = query.order_by(Part.id.desc()).limit(limit).all()

    return json_response(
        {
            "count": len(parts),
            "parts": [
                {
                    "id": p.id,
                    "internal_pn": p.internal_pn,
                    "name": p.name,
                    "category": p.category,
                    "external_pn": p.external_pn,
                    "description": p.description,
                    "tier": p.tier,
                    "parent_id": p.parent_id,
                    "lifecycle_state": p.lifecycle_state,
                }
                for p in parts
            ],
        }
    )


async def _get_part(db, args: dict) -> list[TextContent]:
    """Get a specific part by ID."""
    from opal.db.models import InventoryConsumption, InventoryRecord

    part = (
        db.query(Part)
        .filter(
            Part.id == args["part_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    # Get tier name from project
    tier_name = None
    project = get_active_project()
    if project:
        tier_config = project.get_tier(part.tier)
        if tier_config:
            tier_name = tier_config.name

    # Get children (sub-parts)
    children = db.query(Part).filter(Part.parent_id == part.id, Part.deleted_at.is_(None)).all()

    # Get consumption history (which OPs used this part)
    consumptions = (
        db.query(InventoryConsumption)
        .join(InventoryRecord, InventoryConsumption.inventory_record_id == InventoryRecord.id)
        .filter(InventoryRecord.part_id == part.id)
        .order_by(InventoryConsumption.created_at.desc())
        .limit(10)
        .all()
    )

    return json_response(
        {
            "id": part.id,
            "internal_pn": part.internal_pn,
            "external_pn": part.external_pn,
            "name": part.name,
            "description": part.description,
            "category": part.category,
            "tier": part.tier,
            "tier_name": tier_name,
            "parent_id": part.parent_id,
            "unit_of_measure": part.unit_of_measure,
            "lifecycle_state": part.lifecycle_state,
            "activated_at": part.activated_at.isoformat() if part.activated_at else None,
            "activation_cause": part.activation_cause,
            "created_at": part.created_at.isoformat(),
            "children": [
                {"id": c.id, "internal_pn": c.internal_pn, "name": c.name} for c in children
            ],
            "recent_consumptions": [
                {
                    "id": c.id,
                    "quantity": float(c.quantity),
                    "procedure_instance_id": c.procedure_instance_id,
                    "step_execution_id": c.step_execution_id,
                    "consumed_at": c.created_at.isoformat(),
                }
                for c in consumptions
            ],
        }
    )


def _tier_name(tier: int) -> str | None:
    """Look up the configured display name for a tier, if any."""
    project = get_active_project()
    if project:
        tier_config = project.get_tier(tier)
        if tier_config:
            return tier_config.name
    return None


def _build_part(db, args: dict) -> Part:
    """Construct (but do not commit) a Part from tool args.

    Assigns the internal_pn (validated override or next auto number).
    Shared by create_part and bulk_create_parts. The caller is responsible
    for db.add / flush / log_create / commit. Raises PartNumberError on a
    malformed or already-taken override.
    """
    tier = args.get("tier", 1)
    override = args.get("internal_pn")
    if override:
        if pn_exists(db, override):
            raise PartNumberError(
                f"Part number {override} is already taken (numbers are never "
                "reused, including by deleted parts)"
            )
        register_part_number(db, tier, override)
        internal_pn = override
    else:
        internal_pn = next_part_number(db, tier)

    raw_tracking = args.get("tracking_type")
    tracking_type = TrackingType(raw_tracking) if raw_tracking else None

    return Part(
        name=args["name"],
        internal_pn=internal_pn,
        category=args.get("category"),
        description=args.get("description"),
        external_pn=args.get("external_pn"),
        unit_of_measure=args.get("unit_of_measure", "each"),
        tier=tier,
        parent_id=args.get("parent_id"),
        reorder_point=Decimal(str(args["reorder_point"]))
        if args.get("reorder_point") is not None
        else None,
        **({"tracking_type": tracking_type} if tracking_type is not None else {}),
    )


async def _create_part(db, args: dict) -> list[TextContent]:
    """Create a new part."""
    # Validate parent if specified
    parent_id = args.get("parent_id")
    if parent_id:
        parent = db.query(Part).filter(Part.id == parent_id, Part.deleted_at.is_(None)).first()
        if not parent:
            return json_response({"error": f"Parent part {parent_id} not found"})

    tier = args.get("tier", 1)
    try:
        part = _build_part(db, args)
    except PartNumberError as e:
        return json_response({"error": str(e)})
    db.add(part)
    db.flush()
    log_create(db, part)
    db.commit()
    db.refresh(part)

    return json_response(
        {
            "success": True,
            "message": f"Created draft part '{part.name}' with ID {part.id} ({part.internal_pn})",
            "part": {
                "id": part.id,
                "internal_pn": part.internal_pn,
                "name": part.name,
                "category": part.category,
                "tier": tier,
                "tier_name": _tier_name(tier),
                "parent_id": parent_id,
                "lifecycle_state": part.lifecycle_state,
            },
        }
    )


def _build_part_tree(db, part: Part, depth: int, current_depth: int = 0) -> dict:
    """Recursively build a part tree."""
    result = {
        "id": part.id,
        "internal_pn": part.internal_pn,
        "name": part.name,
        "tier": part.tier,
        "category": part.category,
    }

    if current_depth < depth:
        children = db.query(Part).filter(Part.parent_id == part.id, Part.deleted_at.is_(None)).all()
        if children:
            result["children"] = [
                _build_part_tree(db, child, depth, current_depth + 1) for child in children
            ]

    return result


async def _get_part_tree(db, args: dict) -> list[TextContent]:
    """Get part hierarchy tree."""
    depth = args.get("depth", 3)
    part_id = args.get("part_id")

    if part_id:
        # Start from a specific part
        part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
        if not part:
            return json_response({"error": f"Part {part_id} not found"})
        tree = _build_part_tree(db, part, depth)
    else:
        # Get all top-level parts (no parent)
        top_level = db.query(Part).filter(Part.parent_id.is_(None), Part.deleted_at.is_(None)).all()
        tree = {"top_level_parts": [_build_part_tree(db, p, depth) for p in top_level]}

    return json_response(tree)


async def _get_part_consumption_history(db, args: dict) -> list[TextContent]:
    """Get detailed consumption history for a part."""
    from opal.db.models import InventoryConsumption, InventoryRecord
    from opal.db.models.execution import ProcedureInstance, StepExecution

    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    limit = args.get("limit", 20)

    # Get consumption records with related info
    consumptions = (
        db.query(InventoryConsumption, InventoryRecord, ProcedureInstance, StepExecution)
        .join(InventoryRecord, InventoryConsumption.inventory_record_id == InventoryRecord.id)
        .outerjoin(
            ProcedureInstance, InventoryConsumption.procedure_instance_id == ProcedureInstance.id
        )
        .outerjoin(StepExecution, InventoryConsumption.step_execution_id == StepExecution.id)
        .filter(InventoryRecord.part_id == args["part_id"])
        .order_by(InventoryConsumption.created_at.desc())
        .limit(limit)
        .all()
    )

    history = []
    for consumption, inv_record, proc_instance, step_exec in consumptions:
        entry = {
            "consumption_id": consumption.id,
            "quantity": float(consumption.quantity),
            "usage_type": consumption.usage_type.value
            if hasattr(consumption.usage_type, "value")
            else consumption.usage_type,
            "consumed_at": consumption.created_at.isoformat(),
            "opal_number": inv_record.opal_number,
            "notes": consumption.notes,
        }
        if proc_instance:
            entry["procedure_instance"] = {
                "id": proc_instance.id,
                "procedure_id": proc_instance.procedure_id,
                "work_order_number": proc_instance.work_order_number,
                "status": proc_instance.status.value
                if hasattr(proc_instance.status, "value")
                else proc_instance.status,
            }
        if step_exec:
            entry["step"] = {
                "id": step_exec.id,
                "step_number": step_exec.step_number_str,
            }
        history.append(entry)

    return json_response(
        {
            "part_id": part.id,
            "internal_pn": part.internal_pn,
            "part_name": part.name,
            "total_consumptions": len(history),
            "history": history,
        }
    )


async def _list_procedures(db, args: dict) -> list[TextContent]:
    """List procedures with optional filtering."""
    query = db.query(MasterProcedure).filter(MasterProcedure.deleted_at.is_(None))

    if args.get("status"):
        query = query.filter(MasterProcedure.status == args["status"])

    if args.get("search"):
        search = f"%{args['search']}%"
        query = query.filter(MasterProcedure.name.ilike(search))

    procedures = query.order_by(MasterProcedure.id.desc()).limit(50).all()

    return json_response(
        {
            "count": len(procedures),
            "procedures": [
                {
                    "id": p.id,
                    "name": p.name,
                    "status": p.status.value if hasattr(p.status, "value") else p.status,
                    "step_count": len(p.steps),
                }
                for p in procedures
            ],
        }
    )


async def _create_procedure(db, args: dict) -> list[TextContent]:
    """Create a new master procedure template (draft status)."""
    raw_type = args.get("procedure_type", "op")
    try:
        procedure_type = ProcedureType(raw_type)
    except ValueError:
        return json_response(
            {"error": f"Invalid procedure_type {raw_type!r}; expected 'op' or 'build'"}
        )

    procedure = MasterProcedure(
        name=args["name"],
        description=args.get("description"),
        procedure_type=procedure_type.value,
        status=ProcedureStatus.DRAFT.value,
    )
    db.add(procedure)
    db.flush()

    log_create(db, procedure)
    db.commit()
    db.refresh(procedure)

    return json_response(
        {
            "success": True,
            "message": f"Created procedure '{procedure.name}' with ID {procedure.id}",
            "procedure": {
                "id": procedure.id,
                "name": procedure.name,
                "description": procedure.description,
                "procedure_type": procedure_type.value,
                "status": ProcedureStatus.DRAFT.value,
            },
        }
    )


def _calculate_step_number(db, procedure_id: int, parent_step_id: int | None, is_contingency: bool):
    """Calculate the next step_number — mirrors the canonical API helper.

    Top-level normal ops: 1, 2, 3...
    Top-level contingency ops: C1, C2, C3...
    Sub-steps: <parent.step_number>.<N>
    """
    if parent_step_id:
        parent = db.query(ProcedureStep).filter(ProcedureStep.id == parent_step_id).first()
        if not parent:
            return None
        sub_count = (
            db.query(func.count(ProcedureStep.id))
            .filter(ProcedureStep.parent_step_id == parent_step_id)
            .scalar()
        )
        return f"{parent.step_number}.{sub_count + 1}"

    sibling_query = db.query(func.count(ProcedureStep.id)).filter(
        ProcedureStep.procedure_id == procedure_id,
        ProcedureStep.parent_step_id.is_(None),
        ProcedureStep.is_contingency.is_(is_contingency),
    )
    sibling_count = sibling_query.scalar()
    return f"C{sibling_count + 1}" if is_contingency else str(sibling_count + 1)


async def _add_procedure_step(db, args: dict) -> list[TextContent]:
    """Add an OP (top-level) or sub-step to a procedure."""
    procedure = (
        db.query(MasterProcedure)
        .filter(
            MasterProcedure.id == args["procedure_id"],
            MasterProcedure.deleted_at.is_(None),
        )
        .first()
    )

    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    parent_step_id = args.get("parent_step_id")
    if parent_step_id:
        parent = (
            db.query(ProcedureStep)
            .filter(
                ProcedureStep.id == parent_step_id,
                ProcedureStep.procedure_id == procedure.id,
            )
            .first()
        )
        if not parent:
            return json_response(
                {"error": f"Parent step {parent_step_id} not found in procedure {procedure.id}"}
            )
        # Sub-steps inherit contingency status from parent and are always level=1.
        is_contingency = parent.is_contingency
        level = 1
    else:
        is_contingency = bool(args.get("is_contingency", False))
        level = 0

    step_number = _calculate_step_number(db, procedure.id, parent_step_id, is_contingency)
    if step_number is None:
        return json_response({"error": f"Parent step {parent_step_id} not found"})

    max_order = (
        db.query(func.max(ProcedureStep.order))
        .filter(ProcedureStep.procedure_id == procedure.id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    step = ProcedureStep(
        procedure_id=procedure.id,
        parent_step_id=parent_step_id,
        order=next_order,
        step_number=step_number,
        level=level,
        title=args["title"],
        instructions=args.get("instructions"),
        required_data_schema=args.get("required_data_schema"),
        is_contingency=is_contingency,
        requires_signoff=bool(args.get("requires_signoff", False)),
        estimated_duration_minutes=args.get("estimated_duration_minutes"),
        required_role=args.get("required_role"),
        caution=args.get("caution"),
    )
    db.add(step)
    db.flush()

    log_create(db, step)
    db.commit()
    db.refresh(step)

    return json_response(
        {
            "success": True,
            "message": (
                f"Added {'sub-step' if level else 'OP'} {step.step_number} "
                f"'{step.title}' to procedure '{procedure.name}'"
            ),
            "step": {
                "id": step.id,
                "procedure_id": step.procedure_id,
                "parent_step_id": step.parent_step_id,
                "step_number": step.step_number,
                "level": step.level,
                "order": step.order,
                "title": step.title,
                "instructions": step.instructions,
                "is_contingency": step.is_contingency,
                "requires_signoff": step.requires_signoff,
                "estimated_duration_minutes": step.estimated_duration_minutes,
                "required_role": step.required_role,
                "caution": step.caution,
                "required_data_schema": step.required_data_schema,
            },
        }
    )


def _issue_summary(db, issue: Issue) -> dict:
    """Issue facts shared by the MCP issue tools."""
    return {
        "id": issue.id,
        "issue_number": issue.issue_number,
        "title": issue.title,
        "type": issue.issue_type.value if hasattr(issue.issue_type, "value") else issue.issue_type,
        "status": issue.status.value if hasattr(issue.status, "value") else issue.status,
        "disp_state": issue.disp_state,
        "priority": issue.priority.value if hasattr(issue.priority, "value") else issue.priority,
        "containment": issue.containment.value
        if hasattr(issue.containment, "value")
        else issue.containment,
        "holding": [t["label"] for t in holding_readout(db, issue)],
    }


async def _list_issues(db, args: dict) -> list[TextContent]:
    """List issues with optional filtering."""
    query = db.query(Issue).filter(Issue.deleted_at.is_(None))

    if args.get("status"):
        query = query.filter(Issue.status == args["status"])

    if args.get("disp_state"):
        # Four-value STATE filter, mirroring the API: open = advisory-open;
        # undispositioned / dispositioned = containment-bearing only.
        signed = (Issue.disposition_type.isnot(None)) & (Issue.dispositioned_at.isnot(None))
        bearing = Issue.containment != Containment.ADVISORY
        disp_state = args["disp_state"]
        if disp_state == "closed":
            query = query.filter(Issue.status == IssueStatus.CLOSED)
        elif disp_state == "open":
            query = query.filter(
                Issue.status != IssueStatus.CLOSED, Issue.containment == Containment.ADVISORY
            )
        elif disp_state == "dispositioned":
            query = query.filter(Issue.status != IssueStatus.CLOSED, bearing, signed)
        elif disp_state == "undispositioned":
            query = query.filter(Issue.status != IssueStatus.CLOSED, bearing, ~signed)
        else:
            return json_response({"success": False, "error": f"Invalid disp_state: {disp_state}"})

    if args.get("issue_type"):
        query = query.filter(Issue.issue_type == args["issue_type"])

    limit = args.get("limit", 50)
    issues = query.order_by(Issue.id.desc()).limit(limit).all()

    return json_response(
        {
            "count": len(issues),
            "issues": [
                {
                    "id": i.id,
                    "issue_number": i.issue_number,
                    "title": i.title,
                    "type": i.issue_type.value if hasattr(i.issue_type, "value") else i.issue_type,
                    "status": i.status.value if hasattr(i.status, "value") else i.status,
                    "disp_state": i.disp_state,
                    "containment": i.containment.value
                    if hasattr(i.containment, "value")
                    else i.containment,
                    "priority": i.priority.value if hasattr(i.priority, "value") else i.priority,
                }
                for i in issues
            ],
        }
    )


async def _raise_issue(db, args: dict) -> list[TextContent]:
    """Raise a new issue with the capture fields."""
    issue_type = args.get("issue_type", "task")
    priority = args.get("priority", "medium")
    containment = args.get("containment", "advisory")

    issue = Issue(
        issue_number=generate_issue_number(db),
        title=args["title"],
        description=args.get("description"),
        issue_type=IssueType(issue_type),
        status=IssueStatus.OPEN,
        priority=IssuePriority(priority),
        containment=Containment(containment),
        containment_step_id=args.get("containment_step_id"),
        should_be=args.get("should_be"),
        actual=args.get("actual"),
        procedure_instance_id=args.get("procedure_instance_id"),
        raised_step_id=args.get("raised_step_id"),
        raised_by_id=args.get("user_id"),
        part_id=args.get("part_id"),
        assigned_to_id=args.get("assigned_to_id"),
    )
    db.add(issue)
    db.flush()
    log_create(db, issue, args.get("user_id"))
    db.commit()
    db.refresh(issue)

    return json_response(
        {
            "success": True,
            "message": f"Raised {issue.issue_number} '{issue.title}'",
            "issue": _issue_summary(db, issue),
        }
    )


async def _sign_disposition(db, args: dict) -> list[TextContent]:
    """Sign a disposition — releases every containment the issue holds."""
    issue = db.query(Issue).filter(Issue.id == args["issue_id"], Issue.deleted_at.is_(None)).first()
    if not issue:
        return json_response({"success": False, "error": "Issue not found"})

    status = issue.status.value if hasattr(issue.status, "value") else issue.status
    if status == IssueStatus.CLOSED.value:
        return json_response({"success": False, "error": "Issue is closed"})
    if issue.dispositioned:
        return json_response({"success": False, "error": "Disposition already signed"})
    if not issue.containment_bearing:
        return json_response(
            {
                "success": False,
                "error": f"{issue.issue_number} is advisory; there is no disposition to sign",
            }
        )

    try:
        disposition_type = DispositionType(args["disposition_type"])
    except ValueError:
        return json_response(
            {"success": False, "error": f"Invalid disposition type: {args['disposition_type']}"}
        )

    released = [t["label"] for t in holding_readout(db, issue)]

    old_values = get_model_dict(issue)
    issue.disposition_type = disposition_type
    issue.disposition_rationale = args["rationale"]
    issue.dispositioned_by_id = args["user_id"]
    issue.dispositioned_at = datetime.now(UTC)
    log_update(db, issue, old_values, args["user_id"])
    db.flush()
    _recheck_instance_completion(db, issue)
    db.commit()
    db.refresh(issue)

    return json_response(
        {
            "success": True,
            "message": f"Disposition {disposition_type.value} signed on {issue.issue_number}",
            "released": released,
            "self_dispositioned": issue.self_dispositioned,
            "issue": _issue_summary(db, issue),
        }
    )


async def _set_containment(db, args: dict) -> list[TextContent]:
    """Change containment scope; narrowing requires a note (audited)."""
    from opal.db.models.issue import CONTAINMENT_RANK
    from opal.db.models.issue_comment import IssueComment

    issue = db.query(Issue).filter(Issue.id == args["issue_id"], Issue.deleted_at.is_(None)).first()
    if not issue:
        return json_response({"success": False, "error": "Issue not found"})

    try:
        new_containment = Containment(args["containment"])
    except ValueError:
        return json_response(
            {"success": False, "error": f"Invalid containment: {args['containment']}"}
        )

    old_containment = (
        issue.containment.value if hasattr(issue.containment, "value") else issue.containment
    )
    narrowing = CONTAINMENT_RANK[new_containment.value] < CONTAINMENT_RANK[old_containment]
    note = (args.get("note") or "").strip()
    if narrowing and issue.is_blocking and not note:
        return json_response(
            {
                "success": False,
                "error": f"Narrowing containment {old_containment} → {new_containment.value} "
                "releases a hold; a note is required",
            }
        )

    user_id = args.get("user_id")
    old_values = get_model_dict(issue)
    issue.containment = new_containment
    if args.get("containment_step_id") is not None:
        issue.containment_step_id = args["containment_step_id"]
    log_update(db, issue, old_values, user_id)

    if narrowing and note:
        comment = IssueComment(
            issue_id=issue.id,
            user_id=user_id,
            body=f"Containment narrowed {old_containment} → {new_containment.value}: {note}",
        )
        db.add(comment)
        db.flush()
        log_create(db, comment, user_id)

    if narrowing:
        db.flush()
        _recheck_instance_completion(db, issue)

    db.commit()
    db.refresh(issue)

    return json_response({"success": True, "issue": _issue_summary(db, issue)})


async def _get_holds(db, args: dict) -> list[TextContent]:
    """The controller's blocking state for a work order, as JSON."""
    return json_response(get_holds_payload(db, args["execution_id"]))


def _find_risk(db, args: dict) -> "Risk | None":
    """Resolve a non-deleted risk from risk_id or risk_number args."""
    if args.get("risk_id") is not None:
        return db.query(Risk).filter(Risk.id == args["risk_id"], Risk.deleted_at.is_(None)).first()
    if args.get("risk_number"):
        return (
            db.query(Risk)
            .filter(Risk.risk_number == args["risk_number"], Risk.deleted_at.is_(None))
            .first()
        )
    return None


def _risk_dict(risk: Risk) -> dict:
    """Risk summary — risk_number leads; id kept for tool chaining."""
    return {
        "risk_number": risk.risk_number,
        "id": risk.id,
        "title": risk.title,
        "disposition": risk.disposition,
        "statement": risk.statement,
        "probability": risk.probability,
        "impact": risk.impact,
        "score": risk.score,
        "severity": risk.severity,
        "residual_score": risk.residual_score,
        "residual_severity": risk.residual_severity,
        "owner": risk.owner.name if risk.owner else None,
    }


async def _list_risks(db, args: dict) -> list[TextContent]:
    """List risks with optional filtering."""
    from sqlalchemy.orm import selectinload

    query = db.query(Risk).filter(Risk.deleted_at.is_(None))

    if args.get("disposition"):
        query = query.filter(Risk.disposition == args["disposition"])

    # Severity in SQL so the limit applies to the filtered set, not before it.
    score = Risk.probability * Risk.impact
    severity = args.get("severity")
    if severity == "low":
        query = query.filter(score <= 5)
    elif severity == "medium":
        query = query.filter(score > 5, score <= 12)
    elif severity == "high":
        query = query.filter(score > 12)

    limit = args.get("limit", 50)
    risks = (
        query.options(selectinload(Risk.owner), selectinload(Risk.asset_part))
        .order_by(Risk.id.desc())
        .limit(limit)
        .all()
    )

    return json_response({"count": len(risks), "risks": [_risk_dict(r) for r in risks]})


async def _create_risk(db, args: dict) -> list[TextContent]:
    """Create a new risk — born open; scenario fields may arrive incrementally."""
    if args.get("asset_part_id") is not None and (args.get("asset_text") or "").strip():
        return json_response(
            {"error": "asset_part_id and asset_text are exclusive — exactly one names the asset"}
        )

    # The inputSchema's 1-5 bounds are advisory to the client; enforce here —
    # an out-of-range row would 500 every matrix view until hand-fixed.
    for field in ("probability", "impact", "residual_probability", "residual_impact"):
        value = args.get(field)
        if value is not None and not (
            isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 5
        ):
            return json_response({"error": f"{field} must be an integer from 1 to 5"})
    if args.get("owner_id") is not None and db.get(User, args["owner_id"]) is None:
        return json_response({"error": f"Owner user {args['owner_id']} not found"})
    if args.get("asset_part_id") is not None:
        part = (
            db.query(Part)
            .filter(Part.id == args["asset_part_id"], Part.deleted_at.is_(None))
            .first()
        )
        if part is None:
            return json_response({"error": f"Asset part {args['asset_part_id']} not found"})
    if args.get("asset_text") is not None and not args["asset_text"].strip():
        args["asset_text"] = None

    risk = Risk(
        risk_number=generate_risk_number(db),
        disposition=RiskDisposition.OPEN.value,
        title=args["title"],
        description=args.get("description"),
        condition=args.get("condition"),
        departure=args.get("departure"),
        asset_part_id=args.get("asset_part_id"),
        asset_text=args.get("asset_text"),
        consequence=args.get("consequence"),
        owner_id=args.get("owner_id"),
        probability=args["probability"],
        impact=args["impact"],
        residual_probability=args.get("residual_probability"),
        residual_impact=args.get("residual_impact"),
        watch_observable=args.get("watch_observable"),
        watch_threshold=args.get("watch_threshold"),
        watch_contingency=args.get("watch_contingency"),
    )
    db.add(risk)
    db.flush()
    log_create(db, risk)
    db.commit()
    db.refresh(risk)

    return json_response(
        {
            "success": True,
            "message": f"Created risk '{risk.title}' ({risk.risk_number}) with ID {risk.id}",
            "risk": _risk_dict(risk),
        }
    )


async def _lint_risk(db, args: dict) -> list[TextContent]:
    """Lint a stored risk's scenario, or ad-hoc scenario text."""
    if args.get("risk_id") is not None or args.get("risk_number"):
        risk = _find_risk(db, args)
        if not risk:
            return json_response({"error": "Risk not found"})
        findings = risk_lint.lint_risk_row(risk)
        subject = risk.risk_number
    elif any(args.get(field) for field in ("condition", "departure", "consequence")):
        findings = risk_lint.lint_scenario(
            condition=args.get("condition"),
            departure=args.get("departure"),
            consequence=args.get("consequence"),
        )
        subject = "(unsaved scenario)"
    else:
        return json_response(
            {
                "error": "Pass risk_id, risk_number, or scenario text "
                "(condition/departure/consequence)"
            }
        )

    return json_response(
        {
            "subject": subject,
            "findings": {
                field: [f.to_dict() for f in field_findings]
                for field, field_findings in findings.items()
            },
            "would_block_accept": any(
                f.severity == "block_accept"
                for field_findings in findings.values()
                for f in field_findings
            ),
        }
    )


async def _set_risk_disposition(db, args: dict) -> list[TextContent]:
    """Transition a risk's disposition; the state machine names unmet requirements."""
    risk = _find_risk(db, args)
    if not risk:
        return json_response({"error": "Risk not found"})

    user_id = args.get("user_id")
    if risk.disposition == RiskDisposition.ACCEPTED.value:
        # Un-doing a signature is auditable — it cannot be anonymous.
        user, error = _require_human_user(db, args)
        if error:
            return error
        user_id = user.id

    if args.get("realized_issue_id") is not None:
        issue = (
            db.query(Issue)
            .filter(Issue.id == args["realized_issue_id"], Issue.deleted_at.is_(None))
            .first()
        )
        if not issue:
            return json_response({"error": f"Issue {args['realized_issue_id']} not found"})
        old_values = get_model_dict(risk)
        risk.realized_issue_id = issue.id
        log_update(db, risk, old_values, user_id)

    try:
        risk_dispositions.set_disposition(
            db, risk, args["disposition"], user_id, note=args.get("note")
        )
    except risk_dispositions.RiskDispositionError as err:
        db.rollback()
        return json_response({"error": str(err)})

    db.commit()
    db.refresh(risk)
    return json_response(
        {
            "success": True,
            "message": f"{risk.risk_number} disposition set to {risk.disposition}",
            "risk": _risk_dict(risk),
        }
    )


async def _accept_risk(db, args: dict) -> list[TextContent]:
    """Accept a risk — the signature moment; demands a real human user."""
    user, error = _require_human_user(db, args)
    if error:
        return error

    risk = _find_risk(db, args)
    if not risk:
        return json_response({"error": "Risk not found"})

    try:
        risk_dispositions.accept(db, risk, user.id, rationale=args.get("rationale"))
    except risk_dispositions.RiskDispositionError as err:
        db.rollback()
        return json_response({"error": str(err)})

    db.commit()
    db.refresh(risk)
    return json_response(
        {
            "success": True,
            "message": f"{risk.risk_number} accepted by {user.name}",
            "accepted_at": risk.accepted_at.isoformat(),
            "risk": _risk_dict(risk),
        }
    )


async def _link_risk_issue(db, args: dict) -> list[TextContent]:
    """Link an existing issue to a risk as a mitigation or research response."""
    risk = _find_risk(db, args)
    if not risk:
        return json_response({"error": "Risk not found"})

    role = args.get("role", RiskIssueRole.MITIGATION.value)
    if role not in {r.value for r in RiskIssueRole}:
        return json_response({"error": f"Invalid role '{role}' — use mitigation or research"})

    issue = None
    if args.get("issue_id") is not None:
        issue = (
            db.query(Issue).filter(Issue.id == args["issue_id"], Issue.deleted_at.is_(None)).first()
        )
    elif args.get("issue_number"):
        issue = (
            db.query(Issue)
            .filter(Issue.issue_number == args["issue_number"], Issue.deleted_at.is_(None))
            .first()
        )
    if not issue:
        return json_response({"error": "Issue not found — pass issue_id or issue_number"})

    if any(link.issue_id == issue.id for link in risk.issue_links):
        return json_response(
            {"error": f"{issue.issue_number} is already linked to {risk.risk_number}"}
        )

    link = RiskIssueLink(risk_id=risk.id, issue_id=issue.id, role=role)
    db.add(link)
    db.flush()
    log_create(db, link)
    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"Linked {issue.issue_number} to {risk.risk_number} (role: {role})",
            "link": {
                "id": link.id,
                "risk_number": risk.risk_number,
                "risk_id": risk.id,
                "issue_number": issue.issue_number,
                "issue_id": issue.id,
                "role": role,
            },
        }
    )


async def _stamp_risk_review(db, args: dict) -> list[TextContent]:
    """Stamp last_reviewed on risks — the register review ceremony."""
    user, error = _require_human_user(db, args)
    if error:
        return error

    query = db.query(Risk).filter(Risk.deleted_at.is_(None))
    if args.get("risk_ids") is not None:
        # An explicit empty list must NOT silently widen to "stamp everything" —
        # the stamp is the gate ceremony and would falsely satisfy review checks.
        if not args["risk_ids"]:
            return json_response(
                {"error": "risk_ids is empty — omit it to stamp the whole register"}
            )
        query = query.filter(Risk.id.in_(args["risk_ids"]))
    risks = query.all()
    if not risks:
        return json_response({"error": "No matching risks"})

    count = risk_dispositions.stamp_review(db, risks, user.id)
    db.commit()
    return json_response(
        {
            "success": True,
            "stamped": count,
            "reviewed_at": risks[0].last_reviewed_at.isoformat(),
            "message": f"{count} risk(s) review-stamped by {user.name}",
        }
    )


async def _get_project_info(db, args: dict) -> list[TextContent]:
    """Get project information."""
    project = get_active_project()
    settings = get_active_settings()

    # Get counts
    part_count = db.query(Part).filter(Part.deleted_at.is_(None)).count()
    procedure_count = db.query(MasterProcedure).filter(MasterProcedure.deleted_at.is_(None)).count()
    open_issues = (
        db.query(Issue)
        .filter(
            Issue.deleted_at.is_(None),
            Issue.status == IssueStatus.OPEN,
        )
        .count()
    )
    # Open exposure: dispositions in OPEN_DISPOSITIONS (closed/realized excluded)
    open_risks = (
        db.query(Risk)
        .filter(
            Risk.deleted_at.is_(None),
            Risk.disposition.in_(risk_dispositions.OPEN_DISPOSITIONS),
        )
        .count()
    )

    info = {
        "database": settings.database_url,
        "counts": {
            "parts": part_count,
            "procedures": procedure_count,
            "open_issues": open_issues,
            "open_risks": open_risks,
        },
    }

    if project:
        info["project"] = {
            "name": project.name,
            "description": project.description,
            "directory": str(project.project_dir),
            "tiers": [
                {
                    "level": t.level,
                    "name": t.name,
                    "code": t.code,
                    "description": t.description,
                    "default_tracking": t.default_tracking,
                    "require_lot": t.require_lot,
                    "auto_serial": t.auto_serial,
                }
                for t in project.tiers
            ],
            "part_numbering": {
                "prefix": project.part_numbering.prefix,
                "separator": project.part_numbering.separator,
                "sequence_digits": project.part_numbering.sequence_digits,
                "format": project.part_numbering.format,
            },
            "requirements": [
                {
                    "id": r.id,
                    "title": r.title,
                    "description": r.description,
                    "category": r.category,
                }
                for r in project.requirements
            ],
            "categories": project.categories,
        }

    return json_response(info)


async def _preview_part_number(db, args: dict) -> list[TextContent]:
    """Preview a part number: a specific sequence, or the actual next number.

    Never consumes a number — creation (or an explicit reservation) does.
    """
    project = get_active_project()
    tier = args["tier"]
    sequence = args.get("sequence")

    try:
        if sequence is None:
            part_number, sequence = peek_next_part_number(db, tier)
        else:
            if not project:
                return json_response({"error": "No project loaded"})
            part_number = project.generate_part_number(tier, sequence)
        return json_response(
            {
                "part_number": part_number,
                "tier": tier,
                "tier_name": _tier_name(tier),
                "sequence": sequence,
            }
        )
    except ValueError as e:
        return json_response({"error": str(e)})


async def _activate_part(db, args: dict) -> list[TextContent]:
    """Activate a draft part. Agents draft, humans activate."""
    user, error = _require_human_user(db, args)
    if error:
        return error

    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    cause = args.get("cause") or f"manual activation via MCP by {user.name}"
    old_values = get_model_dict(part)
    try:
        activate_part(db, part, user.id, cause)
    except PartLifecycleError as e:
        return json_response({"error": str(e)})
    log_update(db, part, old_values, user.id)
    db.commit()
    db.refresh(part)

    return json_response(
        {
            "success": True,
            "message": f"{part.internal_pn} activated by {user.name}: {part.activation_cause}",
            "part": {
                "id": part.id,
                "internal_pn": part.internal_pn,
                "name": part.name,
                "lifecycle_state": part.lifecycle_state,
                "activated_at": part.activated_at.isoformat(),
                "activation_cause": part.activation_cause,
            },
        }
    )


async def _bulk_activate_parts(db, args: dict) -> list[TextContent]:
    """Activate multiple draft parts in one signed act."""
    user, error = _require_human_user(db, args)
    if error:
        return error

    cause = args.get("cause") or f"bulk activation via MCP by {user.name}"
    activated: list[dict] = []
    skipped: list[dict] = []
    for part_id in args["part_ids"]:
        part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
        if not part:
            skipped.append({"id": part_id, "reason": "not found"})
            continue
        old_values = get_model_dict(part)
        try:
            activate_part(db, part, user.id, cause)
        except PartLifecycleError as e:
            skipped.append({"id": part_id, "internal_pn": part.internal_pn, "reason": str(e)})
            continue
        log_update(db, part, old_values, user.id)
        activated.append({"id": part.id, "internal_pn": part.internal_pn, "name": part.name})
    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"{len(activated)} part(s) activated by {user.name}, {len(skipped)} skipped",
            "activated": activated,
            "skipped": skipped,
        }
    )


async def _reserve_part_numbers(db, args: dict) -> list[TextContent]:
    """Reserve a block of part numbers as real draft rows."""
    tier = args.get("tier", 1)
    count = args["count"]
    if not 1 <= count <= 500:
        return json_response({"error": "count must be between 1 and 500"})
    prefix = args.get("name_prefix") or "RESERVED"

    parts: list[Part] = []
    try:
        for _ in range(count):
            pn = next_part_number(db, tier)
            # Name from the PN's sequence digits so names inherit PN uniqueness
            seq_match = re.search(r"(\d+)$", pn)
            part = Part(
                name=f"{prefix}-{seq_match.group(1) if seq_match else pn}",
                internal_pn=pn,
                tier=tier,
            )
            db.add(part)
            db.flush()
            log_create(db, part)
            parts.append(part)
    except ValueError as e:
        db.rollback()
        return json_response({"error": str(e)})
    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"Reserved {len(parts)} draft part number(s) in tier {tier}: "
            f"{parts[0].internal_pn} .. {parts[-1].internal_pn}",
            "first_pn": parts[0].internal_pn,
            "last_pn": parts[-1].internal_pn,
            "parts": [
                {
                    "id": p.id,
                    "internal_pn": p.internal_pn,
                    "name": p.name,
                    "lifecycle_state": p.lifecycle_state,
                }
                for p in parts
            ],
        }
    )


# ============ REQUIREMENTS TOOLS ============


def _requirement_dict(req: Requirement) -> dict:
    return {
        "id": req.id,
        "req_number": req.req_number,
        "revision": req.revision,
        "lifecycle_state": req.lifecycle_state,
        "title": req.title,
        "statement": req.statement,
        "rationale": req.rationale,
        "category": req.category,
        "parent_id": req.parent_id,
        "level": req.level,
        "verification_method": req.verification_method,
        "tbd": req.tbd,
        "tbr": req.tbr,
        "stale": req.stale,
        "baselined_at": req.baselined_at.isoformat() if req.baselined_at else None,
        "supersedes_id": req.supersedes_id,
    }


def _find_requirement(db, args: dict) -> "Requirement | None":
    if args.get("requirement_id") is not None:
        return (
            db.query(Requirement)
            .filter(Requirement.id == args["requirement_id"], Requirement.deleted_at.is_(None))
            .first()
        )
    if args.get("req_number"):
        return (
            db.query(Requirement)
            .filter(
                Requirement.req_number == args["req_number"],
                Requirement.deleted_at.is_(None),
                Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
            )
            .order_by(Requirement.revision.desc())
            .first()
        )
    return None


async def _list_requirements(db, args: dict) -> list[TextContent]:
    """List first-class requirements with filters."""
    query = db.query(Requirement).filter(Requirement.deleted_at.is_(None))
    if not args.get("include_superseded"):
        query = query.filter(Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value)
    if args.get("state"):
        query = query.filter(Requirement.lifecycle_state == args["state"])
    if args.get("level") is not None:
        query = query.filter(Requirement.level == args["level"])
    if args.get("query"):
        term = f"%{args['query']}%"
        query = query.filter(
            Requirement.req_number.ilike(term)
            | Requirement.title.ilike(term)
            | Requirement.statement.ilike(term)
        )

    limit = args.get("limit", 50)
    reqs = query.order_by(Requirement.req_number, Requirement.revision).limit(limit).all()
    return json_response({"count": len(reqs), "requirements": [_requirement_dict(r) for r in reqs]})


async def _get_requirement(db, args: dict) -> list[TextContent]:
    """Get a requirement with children, allocations, and revision chain."""
    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})

    children = (
        db.query(Requirement)
        .filter(Requirement.parent_id == req.id, Requirement.deleted_at.is_(None))
        .order_by(Requirement.req_number)
        .all()
    )
    allocations = (
        db.query(PartRequirement).filter(PartRequirement.requirement_ref_id == req.id).all()
    )
    revisions = (
        db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .order_by(Requirement.revision)
        .all()
    )
    from opal.se.readiness import readiness

    ready = readiness(db, req)
    result = _requirement_dict(req)
    result["readiness"] = {
        "ready": ready["ready"],
        "failing_checks": [c["key"] for c in ready["checks"] if not c["passed"]],
    }
    result["children"] = [
        {"id": c.id, "req_number": c.req_number, "title": c.title, "level": c.level}
        for c in children
    ]
    result["allocated_parts"] = [{"part_id": a.part_id, "status": a.status} for a in allocations]
    result["revisions"] = [
        {"id": r.id, "revision": r.revision, "lifecycle_state": r.lifecycle_state}
        for r in revisions
    ]
    return json_response(result)


async def _create_requirement(db, args: dict) -> list[TextContent]:
    """Create a new draft requirement."""
    parent = None
    if args.get("parent_id") is not None:
        parent = (
            db.query(Requirement)
            .filter(Requirement.id == args["parent_id"], Requirement.deleted_at.is_(None))
            .first()
        )
        if not parent:
            return json_response({"error": f"Parent requirement {args['parent_id']} not found"})

    level = args.get("level")
    if level is None:
        level = parent.level + 1 if parent else 0

    req = Requirement(
        req_number=generate_requirement_number(db),
        title=args["title"],
        statement=args["statement"],
        rationale=args.get("rationale"),
        category=args.get("category"),
        parent_id=args.get("parent_id"),
        level=level,
        verification_method=args.get("verification_method"),
        tbd=bool(args.get("tbd", False)),
        tbr=bool(args.get("tbr", False)),
    )
    db.add(req)
    db.flush()
    log_create(db, req)
    db.commit()
    db.refresh(req)
    return json_response(
        {
            "success": True,
            "message": f"Created draft requirement {req.req_number}: {req.title}",
            "requirement": _requirement_dict(req),
            "lint": [f.to_dict() for f in se_lint.lint_requirement_row(req)],
        }
    )


async def _update_requirement(db, args: dict) -> list[TextContent]:
    """Update a draft/preliminary requirement in place."""
    from opal.se.lifecycle import LifecycleError, ensure_mutable

    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})
    try:
        ensure_mutable(req)
    except LifecycleError as err:
        return json_response({"error": str(err)})

    old_values = get_model_dict(req)
    for field in (
        "title",
        "statement",
        "rationale",
        "category",
        "parent_id",
        "level",
        "verification_method",
        "tbd",
        "tbr",
    ):
        if field in args:
            setattr(req, field, args[field])

    # Any edit is by definition a fresh look — clear staleness (spec §7).
    req.stale = False

    log_update(db, req, old_values)
    db.commit()
    db.refresh(req)
    return json_response(
        {
            "success": True,
            "requirement": _requirement_dict(req),
            "lint": [f.to_dict() for f in se_lint.lint_requirement_row(req)],
        }
    )


async def _baseline_requirement(db, args: dict) -> list[TextContent]:
    """Baseline a requirement. Agents draft, humans baseline."""
    from opal.se.lifecycle import LifecycleError, baseline

    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})

    # Policy: baselining is a human act. The id must belong to a real,
    # active user who approved this baseline.
    user_id = args.get("user_id")
    user = (
        db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
        if user_id is not None
        else None
    )
    if not user:
        return json_response(
            {
                "error": "Baselining requires the user_id of an active human user "
                "who approved it. Ask the operator which user is approving."
            }
        )

    old_values = get_model_dict(req)
    try:
        baseline(db, req, user.id)
    except LifecycleError as err:
        return json_response({"error": str(err)})
    from opal.se.baseline import write_baseline_event

    write_baseline_event(db, [req], user.id)
    log_update(db, req, old_values, user.id)
    db.commit()
    db.refresh(req)
    return json_response(
        {
            "success": True,
            "message": f"{req.req_number} rev {req.revision} baselined by {user.name}",
            "requirement": _requirement_dict(req),
        }
    )


def _require_human_user(db, args: dict):
    """Signature acts demand a real, active user; returns (user, error_response)."""
    user_id = args.get("user_id")
    user = (
        db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
        if user_id is not None
        else None
    )
    if not user:
        return None, json_response(
            {
                "error": "This action requires the user_id of an active human user "
                "who approved it. Ask the operator which user is approving."
            }
        )
    return user, None


async def _get_baseline_queue(db, args: dict) -> list[TextContent]:
    """Ready-to-baseline set, ordered level asc then req_number."""
    from opal.se.readiness import ready_requirement_ids

    ids = ready_requirement_ids(db)
    rows = db.query(Requirement).filter(Requirement.id.in_(ids)).all() if ids else []
    rows.sort(key=lambda r: (r.level, r.req_number))
    return json_response(
        {
            "count": len(rows),
            "queue": [
                {
                    "id": r.id,
                    "req_number": r.req_number,
                    "revision": r.revision,
                    "title": r.title,
                    "level": r.level,
                    "statement": r.statement,
                }
                for r in rows
            ],
        }
    )


async def _baseline_batch(db, args: dict) -> list[TextContent]:
    """Atomic batch baseline. Agents prepare; a human signs."""
    from opal.se.baseline import baseline_batch

    user, err = _require_human_user(db, args)
    if err:
        return err

    reqs = []
    for req_id in dict.fromkeys(args["ids"]):  # dedupe: a repeated id would double-flip
        req = (
            db.query(Requirement)
            .filter(Requirement.id == req_id, Requirement.deleted_at.is_(None))
            .first()
        )
        if not req:
            return json_response({"error": f"Requirement {req_id} not found"})
        reqs.append(req)

    old_values = {req.id: get_model_dict(req) for req in reqs}
    event, offenders = baseline_batch(
        db, reqs, user.id, label=args.get("label"), note=args.get("note")
    )
    if offenders:
        # baseline_batch validates before any lifecycle flip — nothing to roll back.
        return json_response(
            {"error": "batch aborted — items no longer ready", "offenders": offenders}
        )
    for req in reqs:
        log_update(db, req, old_values[req.id], user.id)
    db.commit()
    return json_response(
        {
            "success": True,
            "event_id": event.id,
            "label": event.label,
            "message": f"{len(reqs)} requirement(s) baselined by {user.name}",
            "baselined": [
                {"id": r.id, "req_number": r.req_number, "revision": r.revision} for r in reqs
            ],
        }
    )


async def _get_baseline_events(db, args: dict) -> list[TextContent]:
    """Baseline events, newest first; event_id narrows to one with its set."""
    from opal.db.models import BaselineEvent

    def event_dict(e: BaselineEvent) -> dict:
        return {
            "id": e.id,
            "label": e.label,
            "note": e.note,
            "signed_by_id": e.signed_by_id,
            "signed_by": e.signed_by.name if e.signed_by else None,
            "created_at": e.created_at.isoformat(),
            "locked": [
                {
                    "id": item.requirement.id,
                    "req_number": item.requirement.req_number,
                    "revision": item.requirement.revision,
                }
                for item in e.items
            ],
        }

    if args.get("event_id"):
        event = db.query(BaselineEvent).filter(BaselineEvent.id == args["event_id"]).first()
        if not event:
            return json_response({"error": f"Baseline event {args['event_id']} not found"})
        return json_response({"event": event_dict(event)})

    events = db.query(BaselineEvent).order_by(BaselineEvent.created_at.desc()).all()
    return json_response({"count": len(events), "events": [event_dict(e) for e in events]})


async def _reaffirm_requirement(db, args: dict) -> list[TextContent]:
    """Clear staleness with a signature. Humans re-affirm; agents prepare."""
    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})

    user, err = _require_human_user(db, args)
    if err:
        return err
    if not req.stale:
        return json_response({"error": f"{req.req_number} is not stale"})

    old_values = get_model_dict(req)
    req.stale = False
    log_update(db, req, old_values, user.id)
    db.commit()
    db.refresh(req)
    return json_response(
        {
            "success": True,
            "message": f"{req.req_number} rev {req.revision} re-affirmed by {user.name}",
            "requirement": _requirement_dict(req),
        }
    )


async def _get_requirement_diff(db, args: dict) -> list[TextContent]:
    """Word diff of statement/rationale between two revisions."""
    from opal.se.redline import redline_segments

    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})

    revisions = {
        r.revision: r
        for r in db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .all()
    }
    rev_b = args.get("rev_b", req.revision)
    rev_a = args.get("rev_a")
    if rev_a is None:
        predecessor = db.get(Requirement, req.supersedes_id) if req.supersedes_id else None
        rev_a = predecessor.revision if predecessor else rev_b
    old = revisions.get(rev_a)
    new = revisions.get(rev_b)
    if not old or not new:
        return json_response(
            {"error": f"Revision not found (have: {sorted(revisions)}, asked: {rev_a}, {rev_b})"}
        )
    return json_response(
        {
            "req_number": req.req_number,
            "rev_a": rev_a,
            "rev_b": rev_b,
            "statement_diff": redline_segments(old.statement, new.statement),
            "rationale_diff": redline_segments(old.rationale or "", new.rationale or ""),
        }
    )


async def _revise_requirement(db, args: dict) -> list[TextContent]:
    """Create the next draft revision of a baselined requirement."""
    from opal.se.lifecycle import LifecycleError, revise

    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})
    try:
        new_req = revise(db, req)
    except LifecycleError as err:
        return json_response({"error": str(err)})
    log_create(db, new_req)
    db.commit()
    db.refresh(new_req)
    return json_response(
        {
            "success": True,
            "message": f"Created {new_req.req_number} rev {new_req.revision} (draft)",
            "requirement": _requirement_dict(new_req),
        }
    )


async def _cancel_requirement(db, args: dict) -> list[TextContent]:
    """Cancel a requirement (terminal)."""
    from opal.se.lifecycle import LifecycleError, cancel

    req = _find_requirement(db, args)
    if not req:
        return json_response({"error": "Requirement not found"})
    old_values = get_model_dict(req)
    try:
        cancel(db, req)
    except LifecycleError as err:
        return json_response({"error": str(err)})
    log_update(db, req, old_values)
    db.commit()
    return json_response({"success": True, "requirement": _requirement_dict(req)})


async def _lint_requirement(db, args: dict) -> list[TextContent]:
    """Lint a stored requirement or ad-hoc statement text."""
    if args.get("requirement_id") or args.get("req_number"):
        req = _find_requirement(db, args)
        if not req:
            return json_response({"error": "Requirement not found"})
        findings = se_lint.lint_requirement_row(req)
        subject = f"{req.req_number} rev {req.revision}"
    elif args.get("statement"):
        findings = se_lint.lint_requirement(
            args["statement"],
            rationale=args.get("rationale"),
            verification_method=args.get("verification_method"),
            tbd=bool(args.get("tbd", False)),
            tbr=bool(args.get("tbr", False)),
        )
        subject = "(unsaved statement)"
    else:
        return json_response({"error": "Pass requirement_id, req_number, or statement"})

    return json_response(
        {
            "subject": subject,
            "finding_count": len(findings),
            "would_block_baseline": any(f.severity == "block_baseline" for f in findings),
            "findings": [f.to_dict() for f in findings],
        }
    )


async def _flowdown_tree(db, args: dict) -> list[TextContent]:
    """Requirement flow-down hierarchy as a nested tree."""
    rows = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.req_number, Requirement.revision)
        .all()
    )
    ids = {r.id for r in rows}
    by_parent: dict[int | None, list[Requirement]] = {}
    for r in rows:
        effective_parent = r.parent_id if r.parent_id in ids else None
        by_parent.setdefault(effective_parent, []).append(r)

    def node(r: Requirement, seen: frozenset[int]) -> dict:
        n = {
            "id": r.id,
            "req_number": r.req_number,
            "revision": r.revision,
            "lifecycle_state": r.lifecycle_state,
            "level": r.level,
            "title": r.title,
            "verification_method": r.verification_method,
            "children": [
                node(c, seen | {r.id}) for c in by_parent.get(r.id, []) if c.id not in seen
            ],
        }
        if r.parent_id is not None and r.parent_id not in ids:
            n["orphan"] = True  # parent superseded/cancelled/deleted — re-parent it
        return n

    if args.get("requirement_id") or args.get("req_number"):
        root = _find_requirement(db, args)
        if not root:
            return json_response({"error": "Requirement not found"})
        return json_response({"tree": [node(root, frozenset({root.id}))]})

    roots = by_parent.get(None, [])
    return json_response({"count": len(rows), "tree": [node(r, frozenset({r.id})) for r in roots]})


async def _list_part_requirements(db, args: dict) -> list[TextContent]:
    """List requirements assigned to a part."""
    part = (
        db.query(Part)
        .filter(
            Part.id == args["part_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    project = get_active_project()
    reqs = db.query(PartRequirement).filter(PartRequirement.part_id == args["part_id"]).all()

    return json_response(
        {
            "part_id": args["part_id"],
            "part_name": part.name,
            "count": len(reqs),
            "requirements": [
                {
                    "id": r.id,
                    "requirement_id": r.requirement_id,
                    "title": project.get_requirement(r.requirement_id).title
                    if project and project.get_requirement(r.requirement_id)
                    else None,
                    "status": r.status,
                    "notes": r.notes,
                    "verified_at": r.verified_at.isoformat() if r.verified_at else None,
                }
                for r in reqs
            ],
        }
    )


async def _assign_requirement(db, args: dict) -> list[TextContent]:
    """Assign a requirement to a part."""
    part = (
        db.query(Part)
        .filter(
            Part.id == args["part_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    # Resolve against the first-class table (current revision), then the
    # deprecated yaml catalog.
    req_row = (
        db.query(Requirement)
        .filter(
            Requirement.req_number == args["requirement_id"],
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.revision.desc())
        .first()
    )
    req_title = req_row.title if req_row else None
    if not req_row:
        project = get_active_project()
        req_config = project.get_requirement(args["requirement_id"]) if project else None
        if req_config:
            req_title = req_config.title
        else:
            return json_response({"error": f"Requirement {args['requirement_id']} not found"})

    # Check if already assigned
    existing = (
        db.query(PartRequirement)
        .filter(
            PartRequirement.part_id == args["part_id"],
            PartRequirement.requirement_id == args["requirement_id"],
        )
        .first()
    )

    if existing:
        return json_response(
            {
                "error": f"Requirement {args['requirement_id']} already assigned to part {args['part_id']}"
            }
        )

    pr = PartRequirement(
        part_id=args["part_id"],
        requirement_id=args["requirement_id"],
        requirement_ref_id=req_row.id if req_row else None,
        notes=args.get("notes"),
    )
    db.add(pr)
    db.flush()
    log_create(db, pr)
    db.commit()
    db.refresh(pr)

    return json_response(
        {
            "success": True,
            "message": f"Assigned requirement '{req_title or args['requirement_id']}' to part '{part.name}'",
            "part_requirement": {
                "id": pr.id,
                "part_id": pr.part_id,
                "requirement_id": pr.requirement_id,
                "status": pr.status,
            },
        }
    )


async def _verify_requirement(db, args: dict) -> list[TextContent]:
    """Verify a part requirement."""
    pr = db.query(PartRequirement).filter(PartRequirement.id == args["part_requirement_id"]).first()

    if not pr:
        return json_response({"error": f"Part requirement {args['part_requirement_id']} not found"})

    old_values = get_model_dict(pr)
    pr.status = "verified"
    pr.verified_at = datetime.now(UTC)
    if args.get("notes"):
        pr.notes = args["notes"]

    log_update(db, pr, old_values)
    db.commit()
    db.refresh(pr)

    return json_response(
        {
            "success": True,
            "message": f"Verified requirement {pr.requirement_id}",
            "part_requirement": {
                "id": pr.id,
                "requirement_id": pr.requirement_id,
                "status": pr.status,
                "verified_at": pr.verified_at.isoformat(),
            },
        }
    )


# ============ BOM TOOLS ============


async def _get_bom(db, args: dict) -> list[TextContent]:
    """Get BOM for an assembly."""
    part = (
        db.query(Part)
        .filter(
            Part.id == args["assembly_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not part:
        return json_response({"error": f"Part {args['assembly_id']} not found"})

    lines = db.query(BOMLine).filter(BOMLine.assembly_id == args["assembly_id"]).all()

    return json_response(
        {
            "assembly_id": part.id,
            "assembly_name": part.name,
            "count": len(lines),
            "components": [
                {
                    "id": line.id,
                    "component_id": line.component_id,
                    "component_name": line.component.name,
                    "component_external_pn": line.component.external_pn,
                    "quantity": line.quantity,
                    "reference_designator": line.reference_designator,
                }
                for line in lines
            ],
        }
    )


async def _add_component(db, args: dict) -> list[TextContent]:
    """Add a component to an assembly's BOM."""
    assembly = (
        db.query(Part)
        .filter(
            Part.id == args["assembly_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not assembly:
        return json_response({"error": f"Assembly part {args['assembly_id']} not found"})

    component = (
        db.query(Part)
        .filter(
            Part.id == args["component_id"],
            Part.deleted_at.is_(None),
        )
        .first()
    )

    if not component:
        return json_response({"error": f"Component part {args['component_id']} not found"})

    if args["assembly_id"] == args["component_id"]:
        return json_response({"error": "A part cannot be a component of itself"})

    # Check if already exists
    existing = (
        db.query(BOMLine)
        .filter(
            BOMLine.assembly_id == args["assembly_id"],
            BOMLine.component_id == args["component_id"],
        )
        .first()
    )

    if existing:
        return json_response(
            {
                "error": f"Component {args['component_id']} already in assembly {args['assembly_id']} BOM"
            }
        )

    line = BOMLine(
        assembly_id=args["assembly_id"],
        component_id=args["component_id"],
        quantity=args.get("quantity", 1),
        reference_designator=args.get("reference_designator"),
    )
    db.add(line)
    db.flush()
    log_create(db, line)
    db.commit()
    db.refresh(line)

    return json_response(
        {
            "success": True,
            "message": f"Added '{component.name}' to '{assembly.name}' BOM",
            "bom_line": {
                "id": line.id,
                "assembly_id": line.assembly_id,
                "component_id": line.component_id,
                "quantity": line.quantity,
            },
        }
    )


async def _remove_component(db, args: dict) -> list[TextContent]:
    """Remove a component from an assembly's BOM."""
    line = db.query(BOMLine).filter(BOMLine.id == args["bom_line_id"]).first()

    if not line:
        return json_response({"error": f"BOM line {args['bom_line_id']} not found"})

    component_name = line.component.name
    assembly_name = line.assembly.name

    log_delete(db, line)
    db.delete(line)
    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"Removed '{component_name}' from '{assembly_name}' BOM",
        }
    )


# ============ PROCEDURE: READ / UPDATE / DELETE / RENUMBER ============


def _serialize_step(step: ProcedureStep) -> dict:
    return {
        "id": step.id,
        "procedure_id": step.procedure_id,
        "parent_step_id": step.parent_step_id,
        "order": step.order,
        "step_number": step.step_number,
        "level": step.level,
        "title": step.title,
        "instructions": step.instructions,
        "required_data_schema": step.required_data_schema,
        "is_contingency": step.is_contingency,
        "requires_signoff": step.requires_signoff,
        "estimated_duration_minutes": step.estimated_duration_minutes,
        "required_role": step.required_role,
        "caution": step.caution,
        "workcenter_id": step.workcenter_id,
    }


def _build_step_tree(steps: list[ProcedureStep]) -> list[dict]:
    """Build the hierarchical step tree, mirroring the canonical helper."""
    children_map: dict[int | None, list[ProcedureStep]] = {}
    for s in steps:
        children_map.setdefault(s.parent_step_id, []).append(s)
    for kids in children_map.values():
        kids.sort(key=lambda s: s.order)

    def build(node: ProcedureStep) -> dict:
        d = _serialize_step(node)
        d["sub_steps"] = [build(c) for c in children_map.get(node.id, [])]
        return d

    return [build(s) for s in children_map.get(None, [])]


def _renumber_procedure_steps(steps: list[ProcedureStep]) -> None:
    """Recompute step_numbers from current `order` values.

    Mirrors src/opal/api/routes/procedures.py:_renumber_procedure_steps.
    Top-level normal -> 1, 2, 3...; top-level contingency -> C1, C2...;
    sub-steps -> <parent_step_number>.<N>.
    """
    top_level = sorted([s for s in steps if s.parent_step_id is None], key=lambda s: s.order)
    normal_idx = 0
    contingency_idx = 0
    for op in top_level:
        if op.is_contingency:
            contingency_idx += 1
            op.step_number = f"C{contingency_idx}"
        else:
            normal_idx += 1
            op.step_number = str(normal_idx)
    children: dict[int, list[ProcedureStep]] = {}
    for s in steps:
        if s.parent_step_id is not None:
            children.setdefault(s.parent_step_id, []).append(s)
    for parent_id, kids in children.items():
        parent = next((s for s in steps if s.id == parent_id), None)
        if parent is None:
            continue
        kids.sort(key=lambda s: s.order)
        for i, kid in enumerate(kids, start=1):
            kid.step_number = f"{parent.step_number}.{i}"


def _load_procedure(db, procedure_id: int) -> MasterProcedure | None:
    return (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )


async def _get_procedure(db, args: dict) -> list[TextContent]:
    """Return a procedure with its full hierarchical step tree, kit, outputs, and deps."""
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == procedure.id)
        .order_by(ProcedureStep.order)
        .all()
    )
    deps = (
        db.query(StepDependency)
        .join(ProcedureStep, StepDependency.step_id == ProcedureStep.id)
        .filter(ProcedureStep.procedure_id == procedure.id)
        .all()
    )
    kit_items = db.query(Kit).filter(Kit.procedure_id == procedure.id).all()
    outputs = db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure.id).all()

    return json_response(
        {
            "id": procedure.id,
            "name": procedure.name,
            "description": procedure.description,
            "procedure_type": procedure.procedure_type.value
            if hasattr(procedure.procedure_type, "value")
            else procedure.procedure_type,
            "status": procedure.status.value
            if hasattr(procedure.status, "value")
            else procedure.status,
            "current_version_id": procedure.current_version_id,
            "step_count": len(steps),
            "steps": _build_step_tree(steps),
            "dependencies": [
                {"step_id": d.step_id, "depends_on_step_id": d.depends_on_step_id} for d in deps
            ],
            "kit": [
                {
                    "id": k.id,
                    "part_id": k.part_id,
                    "part_name": k.part.name,
                    "quantity_required": float(k.quantity_required),
                }
                for k in kit_items
            ],
            "outputs": [
                {
                    "id": o.id,
                    "part_id": o.part_id,
                    "part_name": o.part.name,
                    "quantity_produced": float(o.quantity_produced),
                }
                for o in outputs
            ],
        }
    )


async def _update_procedure(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    old_values = get_model_dict(procedure)
    if "name" in args:
        procedure.name = args["name"]
    if "description" in args:
        procedure.description = args["description"]
    if "status" in args:
        try:
            procedure.status = ProcedureStatus(args["status"]).value
        except ValueError:
            return json_response({"error": f"Invalid status {args['status']!r}"})
    if "procedure_type" in args:
        try:
            procedure.procedure_type = ProcedureType(args["procedure_type"]).value
        except ValueError:
            return json_response({"error": f"Invalid procedure_type {args['procedure_type']!r}"})

    log_update(db, procedure, old_values)
    db.commit()
    db.refresh(procedure)

    return json_response(
        {
            "success": True,
            "message": f"Updated procedure {procedure.id}",
            "procedure": {
                "id": procedure.id,
                "name": procedure.name,
                "description": procedure.description,
                "procedure_type": procedure.procedure_type.value
                if hasattr(procedure.procedure_type, "value")
                else procedure.procedure_type,
                "status": procedure.status.value
                if hasattr(procedure.status, "value")
                else procedure.status,
            },
        }
    )


async def _delete_procedure(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    procedure.deleted_at = datetime.now(UTC)
    log_delete(db, procedure)
    db.commit()
    return json_response({"success": True, "message": f"Soft-deleted procedure {procedure.id}"})


async def _update_step(db, args: dict) -> list[TextContent]:
    step = (
        db.query(ProcedureStep)
        .filter(
            ProcedureStep.id == args["step_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not step:
        return json_response(
            {"error": (f"Step {args['step_id']} not found in procedure {args['procedure_id']}")}
        )

    old_values = get_model_dict(step)
    if "title" in args:
        step.title = args["title"]
    if "instructions" in args:
        step.instructions = args["instructions"]
    if "is_contingency" in args:
        step.is_contingency = bool(args["is_contingency"])
    if "requires_signoff" in args:
        step.requires_signoff = bool(args["requires_signoff"])
    if "estimated_duration_minutes" in args:
        step.estimated_duration_minutes = args["estimated_duration_minutes"]
    if "required_role" in args:
        step.required_role = args["required_role"]
    if "caution" in args:
        step.caution = args["caution"]
    if "required_data_schema" in args:
        step.required_data_schema = args["required_data_schema"]

    log_update(db, step, old_values)
    db.commit()
    db.refresh(step)

    return json_response(
        {"success": True, "message": f"Updated step {step.id}", "step": _serialize_step(step)}
    )


async def _delete_step(db, args: dict) -> list[TextContent]:
    step = (
        db.query(ProcedureStep)
        .filter(
            ProcedureStep.id == args["step_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not step:
        return json_response({"error": f"Step {args['step_id']} not found"})

    deleted_order = step.order
    log_delete(db, step)
    db.delete(step)
    db.flush()

    # Pull remaining steps after the deleted-cascade flush and renumber.
    remaining = (
        db.query(ProcedureStep).filter(ProcedureStep.procedure_id == args["procedure_id"]).all()
    )
    for s in remaining:
        if s.order > deleted_order:
            s.order -= 1
    _renumber_procedure_steps(remaining)
    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"Deleted step {args['step_id']} and renumbered remaining steps",
            "remaining_step_count": len(remaining),
        }
    )


async def _reorder_steps(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    steps = db.query(ProcedureStep).filter(ProcedureStep.procedure_id == procedure.id).all()
    step_map = {s.id: s for s in steps}
    requested = list(args["step_ids"])
    if set(requested) != set(step_map.keys()):
        return json_response(
            {
                "error": (
                    "step_ids must be the exact set of all step IDs in the procedure "
                    f"(got {len(requested)} ids, procedure has {len(step_map)} steps)"
                )
            }
        )

    for i, sid in enumerate(requested, start=1):
        step_map[sid].order = i
    _renumber_procedure_steps(steps)
    db.commit()

    ordered = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == procedure.id)
        .order_by(ProcedureStep.order)
        .all()
    )
    return json_response(
        {
            "success": True,
            "message": f"Reordered {len(ordered)} steps",
            "steps": [_serialize_step(s) for s in ordered],
        }
    )


# ============ STEP DEPENDENCIES ============


async def _list_step_dependencies(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    rows = (
        db.query(StepDependency)
        .join(ProcedureStep, StepDependency.step_id == ProcedureStep.id)
        .filter(ProcedureStep.procedure_id == procedure.id)
        .all()
    )
    return json_response(
        {
            "procedure_id": procedure.id,
            "count": len(rows),
            "dependencies": [
                {"step_id": d.step_id, "depends_on_step_id": d.depends_on_step_id} for d in rows
            ],
        }
    )


async def _set_step_dependencies(db, args: dict) -> list[TextContent]:
    """Replace the prerequisite list for a top-level OP. Mirrors the canonical
    set_step_dependencies handler — same-procedure scope, op-level only, no
    self-loops, no cycles."""
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    target_id: int = args["step_id"]
    target = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == target_id, ProcedureStep.procedure_id == procedure.id)
        .first()
    )
    if not target:
        return json_response({"error": f"Step {target_id} not found in procedure {procedure.id}"})
    if target.parent_step_id is not None:
        return json_response({"error": "Dependencies are only allowed on top-level operations"})

    requested = list(dict.fromkeys(args["depends_on"]))
    if target_id in requested:
        return json_response({"error": "A step cannot depend on itself"})

    if requested:
        prereqs = db.query(ProcedureStep).filter(ProcedureStep.id.in_(requested)).all()
        prereq_map = {p.id: p for p in prereqs}
        for pid in requested:
            p = prereq_map.get(pid)
            if p is None or p.procedure_id != procedure.id:
                return json_response({"error": f"Step {pid} is not in this procedure"})
            if p.parent_step_id is not None:
                return json_response(
                    {"error": f"Step {pid} is a sub-step; only OPs can be prerequisites"}
                )

    existing = db.query(StepDependency).all()
    adj: dict[int, set[int]] = {}
    for d in existing:
        if d.step_id == target_id:
            continue
        adj.setdefault(d.depends_on_step_id, set()).add(d.step_id)
    for pid in requested:
        adj.setdefault(pid, set()).add(target_id)

    def reachable_from(start: int) -> set[int]:
        seen = {start}
        stack = [start]
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    downstream = reachable_from(target_id)
    cycle = downstream & set(requested)
    if cycle:
        return json_response(
            {
                "error": (
                    f"Cycle: step {target_id} already gates {sorted(cycle)}; cannot depend on them."
                )
            }
        )

    current = db.query(StepDependency).filter(StepDependency.step_id == target_id).all()
    for d in current:
        log_delete(db, d)
        db.delete(d)
    db.flush()
    for pid in requested:
        new_dep = StepDependency(step_id=target_id, depends_on_step_id=pid)
        db.add(new_dep)
        db.flush()
        log_create(db, new_dep)
    db.commit()
    return json_response(
        {
            "success": True,
            "message": (
                f"Set {len(requested)} prerequisite(s) for step {target_id}"
                if requested
                else f"Cleared prerequisites for step {target_id}"
            ),
            "step_id": target_id,
            "depends_on": requested,
        }
    )


# ============ KIT (procedure-level BOM) ============


async def _get_kit(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    items = (
        db.query(Kit).join(Part).filter(Kit.procedure_id == procedure.id).order_by(Part.name).all()
    )
    return json_response(
        {
            "procedure_id": procedure.id,
            "count": len(items),
            "kit": [
                {
                    "id": k.id,
                    "part_id": k.part_id,
                    "part_name": k.part.name,
                    "part_external_pn": k.part.external_pn,
                    "quantity_required": float(k.quantity_required),
                }
                for k in items
            ],
        }
    )


async def _add_kit_item(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    existing = (
        db.query(Kit)
        .filter(Kit.procedure_id == procedure.id, Kit.part_id == args["part_id"])
        .first()
    )
    if existing:
        return json_response(
            {"error": f"Part {args['part_id']} already in kit (use update_kit_item)"}
        )

    item = Kit(
        procedure_id=procedure.id,
        part_id=args["part_id"],
        quantity_required=Decimal(str(args["quantity_required"])),
    )
    db.add(item)
    db.flush()
    log_create(db, item)
    db.commit()
    db.refresh(item)
    return json_response(
        {
            "success": True,
            "message": f"Added '{part.name}' to procedure {procedure.id} kit",
            "kit_item": {
                "id": item.id,
                "part_id": item.part_id,
                "quantity_required": float(item.quantity_required),
            },
        }
    )


async def _update_kit_item(db, args: dict) -> list[TextContent]:
    item = (
        db.query(Kit)
        .filter(Kit.id == args["kit_id"], Kit.procedure_id == args["procedure_id"])
        .first()
    )
    if not item:
        return json_response({"error": f"Kit item {args['kit_id']} not found"})

    old_values = get_model_dict(item)
    item.quantity_required = Decimal(str(args["quantity_required"]))
    log_update(db, item, old_values)
    db.commit()
    db.refresh(item)
    return json_response(
        {
            "success": True,
            "message": f"Updated kit item {item.id} quantity to {item.quantity_required}",
            "kit_item": {
                "id": item.id,
                "part_id": item.part_id,
                "quantity_required": float(item.quantity_required),
            },
        }
    )


async def _remove_kit_item(db, args: dict) -> list[TextContent]:
    item = (
        db.query(Kit)
        .filter(Kit.procedure_id == args["procedure_id"], Kit.part_id == args["part_id"])
        .first()
    )
    if not item:
        return json_response(
            {
                "error": (
                    f"Kit item for part {args['part_id']} not found in "
                    f"procedure {args['procedure_id']}"
                )
            }
        )

    log_delete(db, item)
    db.delete(item)
    db.commit()
    return json_response({"success": True, "message": f"Removed part {args['part_id']} from kit"})


# ============ PROCEDURE OUTPUTS (build-type) ============


async def _get_outputs(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    outputs = db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure.id).all()
    return json_response(
        {
            "procedure_id": procedure.id,
            "procedure_type": procedure.procedure_type.value
            if hasattr(procedure.procedure_type, "value")
            else procedure.procedure_type,
            "count": len(outputs),
            "outputs": [
                {
                    "id": o.id,
                    "part_id": o.part_id,
                    "part_name": o.part.name,
                    "part_external_pn": o.part.external_pn,
                    "quantity_produced": float(o.quantity_produced),
                }
                for o in outputs
            ],
        }
    )


async def _add_output(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    existing = (
        db.query(ProcedureOutput)
        .filter(
            ProcedureOutput.procedure_id == procedure.id,
            ProcedureOutput.part_id == args["part_id"],
        )
        .first()
    )
    if existing:
        return json_response(
            {"error": f"Part {args['part_id']} already in outputs (use update_output)"}
        )

    qty = Decimal(str(args.get("quantity_produced", 1)))
    output = ProcedureOutput(
        procedure_id=procedure.id, part_id=args["part_id"], quantity_produced=qty
    )
    db.add(output)
    db.flush()
    log_create(db, output)

    # Mirror canonical add_output: auto-populate the procedure kit from the
    # output part's direct BOM children (single-level).
    bom_lines = db.query(BOMLine).filter(BOMLine.assembly_id == args["part_id"]).all()
    auto_added = 0
    auto_bumped = 0
    for bom_line in bom_lines:
        kit_qty = Decimal(str(bom_line.quantity)) * qty
        existing_kit = (
            db.query(Kit)
            .filter(Kit.procedure_id == procedure.id, Kit.part_id == bom_line.component_id)
            .first()
        )
        if existing_kit:
            old_values = get_model_dict(existing_kit)
            existing_kit.quantity_required += kit_qty
            log_update(db, existing_kit, old_values)
            auto_bumped += 1
        else:
            new_kit = Kit(
                procedure_id=procedure.id,
                part_id=bom_line.component_id,
                quantity_required=kit_qty,
            )
            db.add(new_kit)
            db.flush()
            log_create(db, new_kit)
            auto_added += 1

    db.commit()
    db.refresh(output)
    return json_response(
        {
            "success": True,
            "message": (
                f"Added output '{part.name}' (qty {qty}) to procedure "
                f"{procedure.id}; auto-added {auto_added} kit item(s), bumped {auto_bumped}"
            ),
            "output": {
                "id": output.id,
                "part_id": output.part_id,
                "quantity_produced": float(output.quantity_produced),
            },
            "kit_auto_added": auto_added,
            "kit_auto_bumped": auto_bumped,
        }
    )


async def _update_output(db, args: dict) -> list[TextContent]:
    output = (
        db.query(ProcedureOutput)
        .filter(
            ProcedureOutput.procedure_id == args["procedure_id"],
            ProcedureOutput.part_id == args["part_id"],
        )
        .first()
    )
    if not output:
        return json_response(
            {
                "error": (
                    f"Output for part {args['part_id']} not found in procedure "
                    f"{args['procedure_id']}"
                )
            }
        )

    old_values = get_model_dict(output)
    output.quantity_produced = Decimal(str(args["quantity_produced"]))
    log_update(db, output, old_values)
    db.commit()
    db.refresh(output)
    return json_response(
        {
            "success": True,
            "message": f"Updated output quantity to {output.quantity_produced}",
            "output": {
                "id": output.id,
                "part_id": output.part_id,
                "quantity_produced": float(output.quantity_produced),
            },
        }
    )


async def _remove_output(db, args: dict) -> list[TextContent]:
    output = (
        db.query(ProcedureOutput)
        .filter(
            ProcedureOutput.procedure_id == args["procedure_id"],
            ProcedureOutput.part_id == args["part_id"],
        )
        .first()
    )
    if not output:
        return json_response(
            {
                "error": (
                    f"Output for part {args['part_id']} not found in procedure "
                    f"{args['procedure_id']}"
                )
            }
        )

    log_delete(db, output)
    db.delete(output)
    db.commit()
    return json_response({"success": True, "message": f"Removed output part {args['part_id']}"})


# ============ STEP KIT (step-level BOM) ============


async def _get_step_kit(db, args: dict) -> list[TextContent]:
    step = (
        db.query(ProcedureStep)
        .filter(
            ProcedureStep.id == args["step_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not step:
        return json_response({"error": f"Step {args['step_id']} not found"})

    return json_response(
        {
            "procedure_id": step.procedure_id,
            "step_id": step.id,
            "step_number": step.step_number,
            "count": len(step.step_kits),
            "items": [
                {
                    "id": sk.id,
                    "part_id": sk.part_id,
                    "part_name": sk.part.name,
                    "part_external_pn": sk.part.external_pn,
                    "quantity_required": float(sk.quantity_required),
                    "usage_type": sk.usage_type.value
                    if hasattr(sk.usage_type, "value")
                    else sk.usage_type,
                    "notes": sk.notes,
                }
                for sk in step.step_kits
            ],
        }
    )


async def _add_step_kit_item(db, args: dict) -> list[TextContent]:
    step = (
        db.query(ProcedureStep)
        .filter(
            ProcedureStep.id == args["step_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not step:
        return json_response({"error": f"Step {args['step_id']} not found"})

    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    existing = (
        db.query(StepKit)
        .filter(StepKit.step_id == step.id, StepKit.part_id == args["part_id"])
        .first()
    )
    if existing:
        return json_response(
            {
                "error": (
                    f"Part {args['part_id']} already in step {step.id} kit "
                    "(use update_step_kit_item)"
                )
            }
        )

    try:
        usage = UsageType(args.get("usage_type", "consume"))
    except ValueError:
        return json_response({"error": f"Invalid usage_type {args.get('usage_type')!r}"})

    sk = StepKit(
        step_id=step.id,
        part_id=args["part_id"],
        quantity_required=Decimal(str(args["quantity_required"])),
        usage_type=usage,
        notes=args.get("notes"),
    )
    db.add(sk)
    db.flush()
    log_create(db, sk)
    db.commit()
    db.refresh(sk)
    return json_response(
        {
            "success": True,
            "message": (
                f"Added '{part.name}' ({usage.value}, qty "
                f"{sk.quantity_required}) to step {step.step_number}"
            ),
            "step_kit_item": {
                "id": sk.id,
                "step_id": sk.step_id,
                "part_id": sk.part_id,
                "quantity_required": float(sk.quantity_required),
                "usage_type": usage.value,
                "notes": sk.notes,
            },
        }
    )


async def _update_step_kit_item(db, args: dict) -> list[TextContent]:
    sk = (
        db.query(StepKit)
        .join(ProcedureStep)
        .filter(
            StepKit.id == args["step_kit_id"],
            StepKit.step_id == args["step_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not sk:
        return json_response({"error": f"Step kit item {args['step_kit_id']} not found"})

    old_values = get_model_dict(sk)
    if "quantity_required" in args:
        sk.quantity_required = Decimal(str(args["quantity_required"]))
    if "usage_type" in args:
        try:
            sk.usage_type = UsageType(args["usage_type"])
        except ValueError:
            return json_response({"error": f"Invalid usage_type {args['usage_type']!r}"})
    if "notes" in args:
        sk.notes = args["notes"]

    log_update(db, sk, old_values)
    db.commit()
    db.refresh(sk)
    return json_response(
        {
            "success": True,
            "message": f"Updated step kit item {sk.id}",
            "step_kit_item": {
                "id": sk.id,
                "part_id": sk.part_id,
                "quantity_required": float(sk.quantity_required),
                "usage_type": sk.usage_type.value
                if hasattr(sk.usage_type, "value")
                else sk.usage_type,
                "notes": sk.notes,
            },
        }
    )


async def _remove_step_kit_item(db, args: dict) -> list[TextContent]:
    sk = (
        db.query(StepKit)
        .join(ProcedureStep)
        .filter(
            StepKit.step_id == args["step_id"],
            StepKit.part_id == args["part_id"],
            ProcedureStep.procedure_id == args["procedure_id"],
        )
        .first()
    )
    if not sk:
        return json_response(
            {
                "error": (
                    f"Step kit item for part {args['part_id']} not found on step {args['step_id']}"
                )
            }
        )

    log_delete(db, sk)
    db.delete(sk)
    db.commit()
    return json_response(
        {"success": True, "message": f"Removed part {args['part_id']} from step kit"}
    )


# ============ PUBLISH + VERSIONS + CLONE ============


async def _publish_version(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == procedure.id)
        .order_by(ProcedureStep.order)
        .all()
    )
    if not steps:
        return json_response({"error": "Cannot publish procedure with no steps"})

    # Publish is the procedure's commitment moment — its kit and outputs
    # must not hold draft parts (authoring with drafts is legal; executing
    # isn't).
    step_ids_for_kits = [s.id for s in steps]
    kit_parts = [k.part for k in db.query(Kit).filter(Kit.procedure_id == procedure.id).all()]
    kit_parts += [
        sk.part for sk in db.query(StepKit).filter(StepKit.step_id.in_(step_ids_for_kits)).all()
    ]
    kit_parts += [
        o.part
        for o in db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure.id)
    ]
    drafts = draft_parts_in(kit_parts)
    if drafts:
        blocked = DraftPartsBlocked(f"publish of procedure {procedure.id}", drafts)
        return json_response(blocked.payload(remedy=_MCP_DRAFT_REMEDY))

    max_version = (
        db.query(func.max(ProcedureVersion.version_number))
        .filter(ProcedureVersion.procedure_id == procedure.id)
        .scalar()
    )
    next_version = (max_version or 0) + 1

    step_ids = [s.id for s in steps]
    all_step_kits = db.query(StepKit).filter(StepKit.step_id.in_(step_ids)).all()
    step_kit_map: dict[int, list[StepKit]] = {}
    for sk in all_step_kits:
        step_kit_map.setdefault(sk.step_id, []).append(sk)

    all_deps = db.query(StepDependency).filter(StepDependency.step_id.in_(step_ids)).all()
    step_id_to_order = {s.id: s.order for s in steps}
    depends_on_map: dict[int, list[int]] = {}
    for d in all_deps:
        prereq_order = step_id_to_order.get(d.depends_on_step_id)
        if prereq_order is not None:
            depends_on_map.setdefault(d.step_id, []).append(prereq_order)

    def step_to_dict(step: ProcedureStep) -> dict:
        return {
            "id": step.id,
            "order": step.order,
            "step_number": step.step_number,
            "level": step.level,
            "parent_step_id": step.parent_step_id,
            "title": step.title,
            "instructions": step.instructions,
            "required_data_schema": step.required_data_schema,
            "is_contingency": step.is_contingency,
            "requires_signoff": step.requires_signoff,
            "estimated_duration_minutes": step.estimated_duration_minutes,
            "required_role": step.required_role,
            "caution": step.caution,
            "workcenter_id": step.workcenter_id,
            "depends_on": sorted(depends_on_map.get(step.id, [])),
            "step_kit": [
                {
                    "part_id": sk.part_id,
                    "part_name": sk.part.name,
                    "quantity_required": float(sk.quantity_required),
                    "usage_type": sk.usage_type.value
                    if hasattr(sk.usage_type, "value")
                    else sk.usage_type,
                    "notes": sk.notes,
                }
                for sk in step_kit_map.get(step.id, [])
            ],
        }

    kit_items = db.query(Kit).filter(Kit.procedure_id == procedure.id).all()
    output_items = (
        db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure.id).all()
    )

    content = {
        "procedure_name": procedure.name,
        "procedure_description": procedure.description,
        "steps": [step_to_dict(s) for s in steps],
        "kit_items": [
            {"part_id": k.part_id, "quantity_required": float(k.quantity_required)}
            for k in kit_items
        ],
        "output_items": [
            {"part_id": o.part_id, "quantity_produced": float(o.quantity_produced)}
            for o in output_items
        ],
    }

    version = ProcedureVersion(
        procedure_id=procedure.id,
        version_number=next_version,
        content=content,
        created_by_id=None,
    )
    db.add(version)
    db.flush()

    procedure.current_version_id = version.id
    procedure.status = ProcedureStatus.ACTIVE.value

    log_create(db, version)
    db.commit()
    db.refresh(version)

    return json_response(
        {
            "success": True,
            "message": (
                f"Published procedure {procedure.id} as v{next_version} (status -> active)"
            ),
            "version": {
                "id": version.id,
                "procedure_id": version.procedure_id,
                "version_number": version.version_number,
                "step_count": len(steps),
            },
        }
    )


async def _list_versions(db, args: dict) -> list[TextContent]:
    procedure = _load_procedure(db, args["procedure_id"])
    if not procedure:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    versions = (
        db.query(ProcedureVersion)
        .filter(ProcedureVersion.procedure_id == procedure.id)
        .order_by(ProcedureVersion.version_number.desc())
        .all()
    )
    return json_response(
        {
            "procedure_id": procedure.id,
            "current_version_id": procedure.current_version_id,
            "count": len(versions),
            "versions": [
                {
                    "id": v.id,
                    "version_number": v.version_number,
                    "created_at": v.created_at.isoformat(),
                    "created_by_id": v.created_by_id,
                    "is_current": v.id == procedure.current_version_id,
                }
                for v in versions
            ],
        }
    )


async def _clone_procedure(db, args: dict) -> list[TextContent]:
    source = _load_procedure(db, args["procedure_id"])
    if not source:
        return json_response({"error": f"Procedure {args['procedure_id']} not found"})

    clone_name = args.get("new_name") or f"Copy of {source.name}"
    new_procedure = MasterProcedure(
        name=clone_name,
        description=source.description,
        procedure_type=source.procedure_type.value
        if hasattr(source.procedure_type, "value")
        else source.procedure_type,
        status=ProcedureStatus.DRAFT.value,
        current_version_id=None,
    )
    db.add(new_procedure)
    db.flush()

    step_id_map: dict[int, int] = {}
    source_steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == source.id)
        .order_by(ProcedureStep.order)
        .all()
    )

    for s in source_steps:
        new_step = ProcedureStep(
            procedure_id=new_procedure.id,
            order=s.order,
            step_number=s.step_number,
            level=s.level,
            parent_step_id=None,
            title=s.title,
            instructions=s.instructions,
            required_data_schema=s.required_data_schema,
            is_contingency=s.is_contingency,
            requires_signoff=s.requires_signoff,
            estimated_duration_minutes=s.estimated_duration_minutes,
            required_role=s.required_role,
            caution=s.caution,
            workcenter_id=s.workcenter_id,
        )
        db.add(new_step)
        db.flush()
        step_id_map[s.id] = new_step.id

    for s in source_steps:
        if s.parent_step_id and s.parent_step_id in step_id_map:
            new_step = db.query(ProcedureStep).filter(ProcedureStep.id == step_id_map[s.id]).first()
            if new_step:
                new_step.parent_step_id = step_id_map[s.parent_step_id]

    copy_kit = bool(args.get("copy_kit", True))
    copy_outputs = bool(args.get("copy_outputs", True))

    if copy_kit:
        for s in source_steps:
            for sk in db.query(StepKit).filter(StepKit.step_id == s.id).all():
                db.add(
                    StepKit(
                        step_id=step_id_map[s.id],
                        part_id=sk.part_id,
                        quantity_required=sk.quantity_required,
                        usage_type=sk.usage_type,
                        notes=sk.notes,
                    )
                )
        for k in db.query(Kit).filter(Kit.procedure_id == source.id).all():
            db.add(
                Kit(
                    procedure_id=new_procedure.id,
                    part_id=k.part_id,
                    quantity_required=k.quantity_required,
                )
            )

    if copy_outputs:
        for o in db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == source.id).all():
            db.add(
                ProcedureOutput(
                    procedure_id=new_procedure.id,
                    part_id=o.part_id,
                    quantity_produced=o.quantity_produced,
                )
            )

    log_create(db, new_procedure)
    db.commit()
    db.refresh(new_procedure)

    return json_response(
        {
            "success": True,
            "message": (f"Cloned procedure {source.id} -> {new_procedure.id} ('{clone_name}')"),
            "procedure": {
                "id": new_procedure.id,
                "name": new_procedure.name,
                "procedure_type": new_procedure.procedure_type.value
                if hasattr(new_procedure.procedure_type, "value")
                else new_procedure.procedure_type,
                "status": "draft",
                "step_count": len(source_steps),
                "copied_kit": copy_kit,
                "copied_outputs": copy_outputs,
            },
        }
    )


# ============ SUPPLIERS ============


async def _search_suppliers(db, args: dict) -> list[TextContent]:
    """Search suppliers by name substring (non-deleted)."""
    query = db.query(Supplier).filter(Supplier.deleted_at.is_(None))

    if args.get("query"):
        query = query.filter(Supplier.name.ilike(f"%{args['query']}%"))

    limit = args.get("limit", 20)
    suppliers = query.order_by(Supplier.name).limit(limit).all()

    return json_response(
        {
            "count": len(suppliers),
            "suppliers": [
                {
                    "id": s.id,
                    "name": s.name,
                    "code": s.code,
                    "website": s.website,
                    "email": s.email,
                    "is_active": s.is_active,
                }
                for s in suppliers
            ],
        }
    )


async def _create_supplier(db, args: dict) -> list[TextContent]:
    """Create a new supplier."""
    supplier = Supplier(
        name=args["name"],
        code=args.get("code"),
        website=args.get("website"),
        email=args.get("email"),
        phone=args.get("phone"),
        address=args.get("address"),
        notes=args.get("notes"),
    )
    db.add(supplier)
    db.flush()
    log_create(db, supplier)
    db.commit()
    db.refresh(supplier)

    return json_response(
        {
            "success": True,
            "message": f"Created supplier '{supplier.name}' with ID {supplier.id}",
            "supplier": {
                "id": supplier.id,
                "name": supplier.name,
                "code": supplier.code,
                "website": supplier.website,
                "email": supplier.email,
                "phone": supplier.phone,
                "address": supplier.address,
                "is_active": supplier.is_active,
            },
        }
    )


# ============ WORKCENTERS ============


def _derive_workcenter_code(name: str) -> str:
    """Derive a short uppercase code from a workcenter name."""
    letters = "".join(ch for ch in name.upper() if ch.isalnum())
    return (letters[:8] or "WC") if letters else "WC"


async def _create_workcenter(db, args: dict) -> list[TextContent]:
    """Create a new workcenter. Code is required+unique; derive if omitted."""
    # Match API behavior: case-insensitive duplicate check, store uppercased
    code = (args.get("code") or _derive_workcenter_code(args["name"])).upper()

    existing = db.query(Workcenter).filter(func.lower(Workcenter.code) == code.lower()).first()
    if existing:
        return json_response({"error": f"Workcenter code '{code}' already exists"})

    workcenter = Workcenter(
        name=args["name"],
        code=code,
        description=args.get("description"),
        location=args.get("location"),
    )
    db.add(workcenter)
    db.flush()
    log_create(db, workcenter)
    db.commit()
    db.refresh(workcenter)

    return json_response(
        {
            "success": True,
            "message": f"Created workcenter '{workcenter.name}' ({workcenter.code})",
            "workcenter": {
                "id": workcenter.id,
                "name": workcenter.name,
                "code": workcenter.code,
                "description": workcenter.description,
                "location": workcenter.location,
                "is_active": workcenter.is_active,
            },
        }
    )


# ============ INVENTORY SUMMARY ============


async def _get_inventory_summary(db, args: dict) -> list[TextContent]:
    """Summarize stock for a part: totals, by-location, and calibration."""
    part = db.query(Part).filter(Part.id == args["part_id"], Part.deleted_at.is_(None)).first()
    if not part:
        return json_response({"error": f"Part {args['part_id']} not found"})

    records = db.query(InventoryRecord).filter(InventoryRecord.part_id == part.id).all()

    total_qty = sum((r.quantity for r in records), Decimal(0))
    by_location = [
        {
            "location": r.location,
            "qty": float(r.quantity),
            "opal_number": r.opal_number,
        }
        for r in records
    ]

    summary = {
        "part_id": part.id,
        "part_name": part.name,
        "internal_pn": part.internal_pn,
        "tier": part.tier,
        "total_qty": float(total_qty),
        "record_count": len(records),
        "by_location": by_location,
        "is_tooling": part.is_tooling,
    }

    if part.is_tooling:
        # No stored calibration_status field; compute from calibration_due_at.
        # The earliest due date across records is the binding one.
        due_dates = [r.calibration_due_at for r in records if r.calibration_due_at is not None]
        now = datetime.now(UTC)
        if not due_dates:
            calibration_status = "unknown"
            earliest_due = None
        else:
            earliest_due = min(due_dates)
            # SQLite returns naive datetimes; normalize to UTC for comparison.
            cmp_due = earliest_due if earliest_due.tzinfo else earliest_due.replace(tzinfo=UTC)
            calibration_status = "overdue" if cmp_due <= now else "ok"
        summary["calibration_due_at"] = earliest_due.isoformat() if earliest_due else None
        summary["calibration_status"] = calibration_status
        summary["calibration_interval_days"] = part.calibration_interval_days

    return json_response(summary)


# ============ BULK PART CREATION ============


async def _bulk_create_parts(db, args: dict) -> list[TextContent]:
    """Create multiple parts in a single transaction."""
    part_args = args.get("parts") or []
    if not part_args:
        return json_response({"error": "No parts provided"})

    # Validate all parent_ids up front so the whole batch is rejected cleanly.
    for idx, pa in enumerate(part_args):
        if not pa.get("name"):
            return json_response({"error": f"Part at index {idx} is missing required 'name'"})
        parent_id = pa.get("parent_id")
        if parent_id:
            parent = db.query(Part).filter(Part.id == parent_id, Part.deleted_at.is_(None)).first()
            if not parent:
                return json_response(
                    {"error": f"Parent part {parent_id} not found (part index {idx})"}
                )

    created = []
    try:
        for pa in part_args:
            part = _build_part(db, pa)
            db.add(part)
            db.flush()
            log_create(db, part)
            created.append(part)
    except PartNumberError as e:
        db.rollback()
        return json_response({"error": f"Part at index {len(created)}: {e} — batch rejected"})

    db.commit()

    return json_response(
        {
            "success": True,
            "message": f"Created {len(created)} draft part(s)",
            "count": len(created),
            "parts": [
                {
                    "id": p.id,
                    "internal_pn": p.internal_pn,
                    "name": p.name,
                    "category": p.category,
                    "tier": p.tier,
                    "tier_name": _tier_name(p.tier),
                    "is_tooling": p.is_tooling,
                    "parent_id": p.parent_id,
                    "lifecycle_state": p.lifecycle_state,
                }
                for p in created
            ],
        }
    )


# ============ PURCHASE ORDERS ============


async def _create_purchase_order(db, args: dict) -> list[TextContent]:
    """Create a purchase order with line items."""
    supplier = (
        db.query(Supplier)
        .filter(Supplier.id == args["supplier_id"], Supplier.deleted_at.is_(None))
        .first()
    )
    if not supplier:
        return json_response({"error": f"Supplier {args['supplier_id']} not found"})

    line_args = args.get("lines") or []
    if not line_args:
        return json_response({"error": "A purchase order requires at least one line"})

    # Validate parts before creating anything.
    for line in line_args:
        part = db.query(Part).filter(Part.id == line["part_id"], Part.deleted_at.is_(None)).first()
        if not part:
            return json_response({"error": f"Part {line['part_id']} not found"})

    # A PO line is a financial commitment — draft parts block it; activation
    # never happens as a side effect.
    try:
        ensure_parts_active(db, [line["part_id"] for line in line_args], "purchase order line add")
    except DraftPartsBlocked as e:
        return json_response(e.payload(remedy=_MCP_DRAFT_REMEDY))

    # POs created outside this tool (UI, seed data) use the same PO-NNNN
    # format without consuming the designator sequence — skip past any
    # already-taken references instead of failing the unique constraint.
    reference = generate_designator(db, "PO", digits=4)
    while db.query(Purchase).filter(Purchase.reference == reference).first() is not None:
        reference = generate_designator(db, "PO", digits=4)
    purchase = Purchase(
        reference=reference,
        supplier=supplier.name,
        supplier_id=supplier.id,
        status=PurchaseStatus.DRAFT,
        notes=args.get("notes"),
    )
    db.add(purchase)
    db.flush()

    for line in line_args:
        db.add(
            PurchaseLine(
                purchase_id=purchase.id,
                part_id=line["part_id"],
                qty_ordered=Decimal(str(line["quantity"])),
                unit_cost=Decimal(str(line["unit_cost"]))
                if line.get("unit_cost") is not None
                else None,
                notes=line.get("notes"),
            )
        )

    db.flush()
    log_create(db, purchase)
    db.commit()
    db.refresh(purchase)

    return json_response(
        {
            "success": True,
            "message": f"Created purchase order {reference} with {len(line_args)} line(s)",
            "purchase_id": purchase.id,
            "po_number": purchase.reference,
            "supplier_id": purchase.supplier_id,
            "line_count": len(line_args),
            "status": purchase.status.value
            if hasattr(purchase.status, "value")
            else purchase.status,
        }
    )


# ============ COMPOSITE PROCEDURE BUILD ============


async def _build_procedure(db, args: dict) -> list[TextContent]:
    """Create a full procedure (steps, step kits, kit, outputs) in one call."""
    raw_type = args.get("procedure_type", "op")
    try:
        procedure_type = ProcedureType(raw_type)
    except ValueError:
        return json_response(
            {"error": f"Invalid procedure_type {raw_type!r}; expected 'op' or 'build'"}
        )

    steps_in = args.get("steps") or []
    kit_in = args.get("kit") or []
    outputs_in = args.get("outputs") or []

    # Validate all referenced parts and workcenters before mutating anything.
    def _part_exists(part_id: int) -> bool:
        return (
            db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first() is not None
        )

    for i, step in enumerate(steps_in):
        if not step.get("title"):
            return json_response({"error": f"Step at index {i} is missing required 'title'"})
        wc_id = step.get("workcenter_id")
        if wc_id and db.query(Workcenter).filter(Workcenter.id == wc_id).first() is None:
            return json_response({"error": f"Workcenter {wc_id} not found (step index {i})"})
        for sk in step.get("step_kits") or []:
            if not _part_exists(sk["part_id"]):
                return json_response(
                    {"error": f"Part {sk['part_id']} not found (step index {i} kit)"}
                )
            try:
                UsageType(sk.get("usage_type", "consume"))
            except ValueError:
                return json_response({"error": f"Invalid usage_type {sk.get('usage_type')!r}"})
    for k in kit_in:
        if not _part_exists(k["part_id"]):
            return json_response({"error": f"Kit part {k['part_id']} not found"})
    for o in outputs_in:
        if not _part_exists(o["part_id"]):
            return json_response({"error": f"Output part {o['part_id']} not found"})

    procedure = MasterProcedure(
        name=args["name"],
        description=args.get("description"),
        procedure_type=procedure_type.value,
        status=ProcedureStatus.DRAFT.value,
    )
    db.add(procedure)
    db.flush()
    log_create(db, procedure)

    step_count = 0
    step_kit_count = 0
    for i, step in enumerate(steps_in):
        ps = ProcedureStep(
            procedure_id=procedure.id,
            parent_step_id=None,
            order=i + 1,
            step_number=str(i + 1),
            level=0,
            title=step["title"],
            instructions=step.get("instructions"),
            required_role=step.get("required_role"),
            caution=step.get("caution"),
            requires_signoff=bool(step.get("requires_signoff", False)),
            estimated_duration_minutes=step.get("estimated_duration_minutes"),
            workcenter_id=step.get("workcenter_id"),
        )
        db.add(ps)
        db.flush()
        log_create(db, ps)
        step_count += 1

        for sk in step.get("step_kits") or []:
            item = StepKit(
                step_id=ps.id,
                part_id=sk["part_id"],
                quantity_required=Decimal(str(sk["quantity_required"])),
                usage_type=UsageType(sk.get("usage_type", "consume")),
            )
            db.add(item)
            db.flush()
            log_create(db, item)
            step_kit_count += 1

    kit_item_count = 0
    for k in kit_in:
        item = Kit(
            procedure_id=procedure.id,
            part_id=k["part_id"],
            quantity_required=Decimal(str(k["quantity_required"])),
        )
        db.add(item)
        db.flush()
        log_create(db, item)
        kit_item_count += 1

    output_count = 0
    for o in outputs_in:
        output = ProcedureOutput(
            procedure_id=procedure.id,
            part_id=o["part_id"],
            quantity_produced=Decimal(str(o.get("quantity_produced", 1))),
        )
        db.add(output)
        db.flush()
        log_create(db, output)
        output_count += 1

    db.commit()
    db.refresh(procedure)

    return json_response(
        {
            "success": True,
            "message": (
                f"Built procedure '{procedure.name}' (ID {procedure.id}) with "
                f"{step_count} step(s), {kit_item_count} kit item(s), "
                f"{output_count} output(s)"
            ),
            "procedure_id": procedure.id,
            "name": procedure.name,
            "step_count": step_count,
            "step_kit_count": step_kit_count,
            "kit_item_count": kit_item_count,
            "output_count": output_count,
        }
    )


# ============ SERVER ENTRY POINT ============


async def run_server():
    """Run the MCP server."""
    import sys

    # stderr, not logging: logging is usually unconfigured here, and stdout
    # carries the MCP protocol. Which database this server is bound to is the
    # first thing to check when MCP and web UI disagree about the data.
    print(f"OPAL MCP server | database: {get_active_settings().database_url}", file=sys.stderr)

    project = get_active_project()
    if project:
        print(f"OPAL MCP server | project: {project.name}", file=sys.stderr)

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )
