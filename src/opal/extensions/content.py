"""Declarative content an extension provides, and importing it into a project.

Extensions do not mutate project data on install. They carry templates; an
operator imports one explicitly and it becomes ordinary project data from that
moment on — a procedure you can edit, a dataset you can record into. That is
why uninstalling an extension does not remove what was imported from it.

Templates are deliberately self-contained: no part numbers, no workcenters, no
references to anything that must already exist in the project. Content that
needs the project to look a certain way belongs in a seed, not an extension.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from opal.extensions.registry import DiscoveredExtension

logger = logging.getLogger("opal.extensions")

#: Cap on how much template content one extension may declare, so a bad file
#: cannot turn a settings page render into an unbounded read.
MAX_TEMPLATE_BYTES = 2 * 1024 * 1024


class ContentError(ValueError):
    """A content file is missing, unparseable, or does not match its schema."""


class SubStepTemplate(BaseModel):
    """A sub-step — same fields as a step, without further nesting."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=255)
    instructions: str | None = None
    caution: str | None = None
    required_role: str | None = Field(default=None, max_length=50)
    requires_signoff: bool = False
    is_contingency: bool = False
    estimated_duration_minutes: int | None = Field(default=None, ge=0)


class StepTemplate(BaseModel):
    """One procedure step. Sub-steps go exactly one level deep, as in the model."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=255)
    instructions: str | None = None
    caution: str | None = None
    required_role: str | None = Field(default=None, max_length=50)
    requires_signoff: bool = False
    is_contingency: bool = False
    strict_sequence: bool = False
    estimated_duration_minutes: int | None = Field(default=None, ge=0)
    sub_steps: list[SubStepTemplate] = Field(default_factory=list)


class ProcedureTemplate(BaseModel):
    """A master procedure an extension offers for import."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(max_length=64, description="Stable id within the extension")
    name: str = Field(max_length=255)
    description: str | None = None
    type: str = Field(default="op")
    steps: list[StepTemplate] = Field(default_factory=list)

    @field_validator("type")
    @classmethod
    def _known_type(cls, value: str) -> str:
        if value not in ("op", "build"):
            raise ValueError("type must be 'op' or 'build'")
        return value


class DatasetTemplate(BaseModel):
    """A dataset definition an extension offers for import."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(max_length=64)
    name: str = Field(max_length=255)
    description: str | None = None
    schema_: dict[str, Any] = Field(alias="schema")

    @field_validator("schema_")
    @classmethod
    def _has_fields(cls, value: dict[str, Any]) -> dict[str, Any]:
        fields = value.get("fields")
        if not isinstance(fields, list) or not fields:
            raise ValueError("schema must contain a non-empty 'fields' list")
        for field in fields:
            if not isinstance(field, dict) or not field.get("name"):
                raise ValueError("every schema field needs a 'name'")
        return value


@dataclass(frozen=True)
class ExtensionContent:
    """Everything one extension provides, plus whatever failed to load."""

    procedures: list[ProcedureTemplate]
    datasets: list[DatasetTemplate]
    errors: list[str]

    @property
    def total(self) -> int:
        return len(self.procedures) + len(self.datasets)

    def counts(self) -> dict[str, int]:
        return {"procedures": len(self.procedures), "datasets": len(self.datasets)}


def _resolve(root: Path, patterns: list[str]) -> list[Path]:
    """Expand glob patterns against the extension root, staying inside it."""
    root = root.resolve()
    paths: list[Path] = []
    for pattern in patterns:
        for match in sorted(root.glob(pattern)):
            resolved = match.resolve()
            if not match.is_file() or root not in resolved.parents:
                continue
            if resolved not in paths:
                paths.append(resolved)
    return paths


def _load_documents(root: Path, patterns: list[str], key: str) -> tuple[list[Any], list[str]]:
    """Read every matching JSON file and return the entries under ``key``."""
    entries: list[Any] = []
    errors: list[str] = []
    for path in _resolve(root, patterns):
        try:
            if path.stat().st_size > MAX_TEMPLATE_BYTES:
                errors.append(f"{path.name}: larger than {MAX_TEMPLATE_BYTES // 1024} KB")
                continue
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
            errors.append(f"{path.name}: {err}")
            continue

        if isinstance(document, dict) and key in document:
            document = document[key]
        if not isinstance(document, list):
            errors.append(f"{path.name}: expected a list of {key}, or an object with a '{key}' key")
            continue
        entries.extend(document)
    return entries, errors


def load_content(ext: DiscoveredExtension) -> ExtensionContent:
    """Read and validate everything an extension declares under `provides:`."""
    provides = ext.manifest.provides
    errors: list[str] = []

    raw_procedures, procedure_errors = _load_documents(ext.root, provides.procedures, "procedures")
    errors.extend(procedure_errors)
    procedures: list[ProcedureTemplate] = []
    for entry in raw_procedures:
        try:
            procedures.append(ProcedureTemplate.model_validate(entry))
        except Exception as err:
            errors.append(f"procedure template rejected: {_short(err)}")

    raw_datasets, dataset_errors = _load_documents(ext.root, provides.datasets, "datasets")
    errors.extend(dataset_errors)
    datasets: list[DatasetTemplate] = []
    for entry in raw_datasets:
        try:
            datasets.append(DatasetTemplate.model_validate(entry))
        except Exception as err:
            errors.append(f"dataset template rejected: {_short(err)}")

    procedures = _dedupe(procedures, "procedure", errors)
    datasets = _dedupe(datasets, "dataset", errors)
    return ExtensionContent(procedures=procedures, datasets=datasets, errors=errors)


def _dedupe(items: list[Any], label: str, errors: list[str]) -> list[Any]:
    """Keep the first entry per key — a duplicate key would make IMPORT ambiguous."""
    seen: dict[str, Any] = {}
    for item in items:
        if item.key in seen:
            errors.append(f"duplicate {label} key {item.key!r} — only the first is offered")
            continue
        seen[item.key] = item
    return list(seen.values())


def _short(err: Exception) -> str:
    errors = getattr(err, "errors", None)
    if callable(errors):
        try:
            first = errors()[0]
            location = ".".join(str(part) for part in first.get("loc", ())) or "template"
            return f"{location}: {first.get('msg', 'invalid')}"
        except (IndexError, TypeError):
            pass
    return str(err)


# ============ Import: template -> project data ============


def import_procedure(
    db: Session, ext: DiscoveredExtension, key: str, user_id: int | None = None
) -> Any:
    """Create a draft master procedure from a template. Caller commits.

    The procedure lands in DRAFT with no published version — publishing it is
    the operator's decision, made through the normal procedure UI.
    """
    from opal.core.audit import log_create
    from opal.db.models.procedure import (
        MasterProcedure,
        ProcedureStatus,
        ProcedureStep,
        ProcedureType,
    )

    template = _pick(load_content(ext).procedures, key, "procedure")

    procedure = MasterProcedure(
        name=template.name,
        description=template.description,
        procedure_type=ProcedureType(template.type),
        status=ProcedureStatus.DRAFT,
    )
    db.add(procedure)
    db.flush()

    order = 0
    for index, step in enumerate(template.steps, start=1):
        parent = ProcedureStep(
            procedure_id=procedure.id,
            order=order,
            step_number=str(index),
            level=0,
            title=step.title,
            instructions=step.instructions,
            caution=step.caution,
            required_role=step.required_role,
            requires_signoff=step.requires_signoff,
            is_contingency=step.is_contingency,
            strict_sequence=step.strict_sequence,
            estimated_duration_minutes=step.estimated_duration_minutes,
        )
        db.add(parent)
        db.flush()
        order += 1

        for sub_index, sub in enumerate(step.sub_steps, start=1):
            db.add(
                ProcedureStep(
                    procedure_id=procedure.id,
                    parent_step_id=parent.id,
                    order=order,
                    step_number=f"{index}.{sub_index}",
                    level=1,
                    title=sub.title,
                    instructions=sub.instructions,
                    caution=sub.caution,
                    required_role=sub.required_role,
                    requires_signoff=sub.requires_signoff,
                    is_contingency=sub.is_contingency,
                    estimated_duration_minutes=sub.estimated_duration_minutes,
                )
            )
            order += 1

    db.flush()
    log_create(db, procedure, user_id=user_id)
    logger.info("Imported procedure %s from extension %s", template.key, ext.id)
    return procedure


def import_dataset(
    db: Session, ext: DiscoveredExtension, key: str, user_id: int | None = None
) -> Any:
    """Create a dataset from a template. Caller commits."""
    from opal.core.audit import log_create
    from opal.db.models.dataset import Dataset

    template = _pick(load_content(ext).datasets, key, "dataset")

    dataset = Dataset(
        name=template.name,
        description=template.description,
        schema=template.schema_,
    )
    db.add(dataset)
    db.flush()
    log_create(db, dataset, user_id=user_id)
    logger.info("Imported dataset %s from extension %s", template.key, ext.id)
    return dataset


def _pick(items: list[Any], key: str, label: str) -> Any:
    for item in items:
        if item.key == key:
            return item
    raise ContentError(f"this extension provides no {label} named {key!r}")


#: Import dispatch, keyed by the capability names the manifest allows. Kept in
#: step with manifest.CAPABILITIES — a capability the manifest accepts but
#: nothing can import would be a promise the settings page cannot keep.
#: tests/unit/test_extensions.py guards the correspondence.
IMPORTERS: dict[str, Callable[..., Any]] = {
    "procedures": import_procedure,
    "datasets": import_dataset,
}
