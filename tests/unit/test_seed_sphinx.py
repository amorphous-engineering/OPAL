"""Mojave Sphinx demo seed — content inventory and live demo-state invariants."""

import json

import pytest

import opal.config as config_mod
from opal.config import PROJECT_CONFIG_KEY, get_app_setting
from opal.core.holds import get_hold_state, get_holds_payload
from opal.db.models import (
    Issue,
    MasterProcedure,
    Part,
    ProcedureInstance,
    ProcedureVersion,
    Requirement,
    Risk,
    StepExecution,
)
from opal.db.models.execution import InstanceStatus, StepNote
from opal.seed import seed_database


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", None)


@pytest.fixture()
def seeded(db_session):
    seed_database(db_session)
    return db_session


def test_content_inventory(seeded):
    assert seeded.query(Part).count() > 150
    assert seeded.query(Part).filter(Part.lifecycle_state == "draft").count() == 3
    assert seeded.query(MasterProcedure).count() == 4
    # every procedure is published
    assert seeded.query(ProcedureVersion).count() == 4
    assert (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.current_version_id.is_(None))
        .count()
        == 0
    )
    assert seeded.query(Requirement).count() == 15
    assert seeded.query(Risk).count() == 17


def test_attribution_in_project_config(seeded):
    config = json.loads(get_app_setting(seeded, PROJECT_CONFIG_KEY))
    assert "Half Cat Rocketry" in config["description"]
    assert "HCR-5100" in config["description"]


def test_vehicle_assembly_has_13_ops_with_step_kits(seeded):
    proc = (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.name == "Mojave Sphinx Vehicle Assembly")
        .one()
    )
    version = seeded.get(ProcedureVersion, proc.current_version_id)
    ops = [s for s in version.content["steps"] if s["level"] == 0]
    assert len(ops) == 13
    assert sum(len(s["step_kit"]) for s in ops) > 100


def test_work_order_states(seeded):
    statuses = sorted(
        s.value if hasattr(s, "value") else s
        for (s,) in seeded.query(ProcedureInstance.status)
    )
    assert statuses == ["completed", "cut", "in_work"]


def test_wo2_boundary_hold_renders(seeded):
    wo2 = (
        seeded.query(ProcedureInstance)
        .filter(ProcedureInstance.status == InstanceStatus.IN_WORK)
        .one()
    )
    boundary = (
        seeded.query(StepExecution)
        .filter(
            StepExecution.instance_id == wo2.id, StepExecution.step_number_str == "6.4"
        )
        .one()
    )
    holds = get_hold_state(seeded, wo2.id)
    assert holds.blockers_for_start(boundary), "resolve-by boundary must hold 6.4"
    payload = get_holds_payload(seeded, wo2.id)
    assert payload["held"]
    assert "6.4 COMPLETE" in payload["holds"][0]["blocks"]


def test_issue_disposition_variety(seeded):
    states = [i.disp_state for i in seeded.query(Issue).all()]
    assert "undispositioned" in states
    assert "dispositioned" in states
    assert "closed" in states


def test_risk_disposition_variety(seeded):
    dispositions = {r.disposition for r in seeded.query(Risk).all()}
    assert {"open", "mitigate", "watch", "accepted", "realized"} <= dispositions
    accepted = seeded.query(Risk).filter(Risk.disposition == "accepted").one()
    assert accepted.accepted_by_id is not None
    assert accepted.acceptance_rationale
    realized = seeded.query(Risk).filter(Risk.disposition == "realized").one()
    assert realized.realized_issue_id is not None


def test_requirement_lifecycle_variety(seeded):
    reqs = seeded.query(Requirement).all()
    assert sum(1 for r in reqs if r.lifecycle_state == "baselined") == 13
    tbrs = [r for r in reqs if r.tbr]
    assert len(tbrs) == 1
    assert tbrs[0].tbr_owner_id is not None
    assert tbrs[0].tbr_due is not None


def test_step_notes_exist(seeded):
    assert seeded.query(StepNote).count() >= 5
