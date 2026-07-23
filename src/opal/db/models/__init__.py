"""Database models."""

from opal.db.models.app_setting import AppSetting
from opal.db.models.attachment import Attachment
from opal.db.models.audit import AuditLog
from opal.db.models.auth import ApiToken, AuthSession, PasskeyCredential, WebauthnChallenge
from opal.db.models.baseline_event import BaselineEvent, BaselineEventItem
from opal.db.models.dataset import DataPoint, Dataset
from opal.db.models.designator import DesignatorSequence
from opal.db.models.execution import ProcedureInstance, StepExecution, StepFocus, StepNote
from opal.db.models.genealogy import AssemblyComponent
from opal.db.models.inventory import (
    InventoryConsumption,
    InventoryProduction,
    InventoryRecord,
    StockTestResult,
    StockTransfer,
    TestTemplate,
)
from opal.db.models.issue import Issue
from opal.db.models.issue_comment import IssueComment
from opal.db.models.onshape_link import OnshapeLink, OnshapeSyncLog
from opal.db.models.part import BOMLine, Part, PartRequirement
from opal.db.models.procedure import (
    Kit,
    MasterProcedure,
    ProcedureOutput,
    ProcedureStep,
    ProcedureVersion,
    StepDependency,
    StepImage,
    StepKit,
)
from opal.db.models.purchase import Purchase, PurchaseExpense, PurchaseLine
from opal.db.models.reference import IssueReference, ReferenceType, RiskReference
from opal.db.models.requirement import Requirement, VerificationMethod
from opal.db.models.risk import Risk, RiskDisposition, RiskIssueLink, RiskIssueRole
from opal.db.models.supplier import Supplier, SupplierPart
from opal.db.models.user import User
from opal.db.models.workcenter import Workcenter

__all__ = [
    "ApiToken",
    "AppSetting",
    "AssemblyComponent",
    "Attachment",
    "AuditLog",
    "AuthSession",
    "BOMLine",
    "BaselineEvent",
    "BaselineEventItem",
    "DataPoint",
    "Dataset",
    "DesignatorSequence",
    "InventoryConsumption",
    "InventoryProduction",
    "InventoryRecord",
    "Issue",
    "IssueComment",
    "IssueReference",
    "Kit",
    "MasterProcedure",
    "OnshapeLink",
    "OnshapeSyncLog",
    "Part",
    "PartRequirement",
    "PasskeyCredential",
    "ProcedureInstance",
    "ProcedureOutput",
    "ProcedureStep",
    "ProcedureVersion",
    "WebauthnChallenge",
    "Purchase",
    "PurchaseExpense",
    "PurchaseLine",
    "ReferenceType",
    "Requirement",
    "Risk",
    "RiskDisposition",
    "RiskIssueLink",
    "RiskIssueRole",
    "RiskReference",
    "StepFocus",
    "StepDependency",
    "StepExecution",
    "StepImage",
    "StepKit",
    "StepNote",
    "StockTestResult",
    "StockTransfer",
    "Supplier",
    "SupplierPart",
    "TestTemplate",
    "User",
    "VerificationMethod",
    "Workcenter",
]
