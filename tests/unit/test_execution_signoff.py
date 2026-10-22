"""Sign-off: a step or OP flagged requires_signoff is not done when its work
completes — it waits in AWAITING_SIGNOFF until someone signs it off, and the
work order cannot close before that."""

from fastapi.testclient import TestClient


def _cut(client: TestClient, *, op_signoff: bool, step_signoff: bool) -> tuple[int, dict]:
    """One OP with two sub-steps; the first sub-step optionally needs sign-off."""
    proc_id = client.post("/api/procedures", json={"name": "Sign-off test"}).json()["id"]
    op = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Pressure test", "requires_signoff": op_signoff},
    ).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Hold 1.5x MEOP",
            "parent_step_id": op["id"],
            "requires_signoff": step_signoff,
        },
    )
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Record leak rate", "parent_step_id": op["id"]},
    )
    assert client.post(f"/api/procedures/{proc_id}/publish").status_code == 201
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    numbers = {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}
    return inst["id"], numbers


def _status(client: TestClient, instance_id: int, number: int) -> str:
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    return next(s["status"] for s in inst["step_executions"] if s["step_number"] == number)


def _instance_status(client: TestClient, instance_id: int) -> str:
    return client.get(f"/api/procedure-instances/{instance_id}").json()["status"]


def _complete(client: TestClient, instance_id: int, number: int):
    return client.post(f"/api/procedure-instances/{instance_id}/steps/{number}/complete", json={})


def _signoff(client: TestClient, instance_id: int, number: int):
    return client.post(f"/api/procedure-instances/{instance_id}/steps/{number}/signoff")


def test_step_requiring_signoff_waits_then_signs_off(client):
    iid, n = _cut(client, op_signoff=False, step_signoff=True)

    r = _complete(client, iid, n["1.1"])
    assert r.status_code == 200, r.text
    assert _status(client, iid, n["1.1"]) == "awaiting_signoff"

    # Completing again is refused; it is waiting on a person, not on work.
    r = _complete(client, iid, n["1.1"])
    assert r.status_code == 400
    assert "awaiting sign-off" in r.json()["detail"]

    # The other sub-step finishing does not close the OP or the work order.
    assert _complete(client, iid, n["1.2"]).status_code == 200
    assert _status(client, iid, n["1"]) != "completed"
    assert _instance_status(client, iid) != "completed"

    r = _signoff(client, iid, n["1.1"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "signed_off"
    assert body["signed_off_at"] is not None

    # Signed-off children count as done: the OP and the work order close.
    assert _status(client, iid, n["1"]) == "completed"
    assert _instance_status(client, iid) == "completed"


def test_op_requiring_signoff_waits_after_children(client):
    iid, n = _cut(client, op_signoff=True, step_signoff=False)
    _complete(client, iid, n["1.1"])
    _complete(client, iid, n["1.2"])

    assert _status(client, iid, n["1"]) == "awaiting_signoff"
    assert _instance_status(client, iid) != "completed"

    r = _signoff(client, iid, n["1"])
    assert r.status_code == 200, r.text
    assert _status(client, iid, n["1"]) == "signed_off"
    assert _instance_status(client, iid) == "completed"


def test_op_without_signoff_still_completes_itself(client):
    iid, n = _cut(client, op_signoff=False, step_signoff=False)
    _complete(client, iid, n["1.1"])
    _complete(client, iid, n["1.2"])
    assert _status(client, iid, n["1"]) == "completed"
    assert _instance_status(client, iid) == "completed"


def test_signoff_refused_before_completion_and_twice(client):
    iid, n = _cut(client, op_signoff=True, step_signoff=True)

    r = _signoff(client, iid, n["1.1"])
    assert r.status_code == 400
    assert "completed before" in r.json()["detail"]

    r = _signoff(client, iid, n["1"])
    assert r.status_code == 400
    assert "not yet complete" in r.json()["detail"]

    _complete(client, iid, n["1.1"])
    assert _signoff(client, iid, n["1.1"]).status_code == 200
    r = _signoff(client, iid, n["1.1"])
    assert r.status_code == 400
    assert "already signed off" in r.json()["detail"]


def test_open_nc_blocks_signoff(client):
    iid, n = _cut(client, op_signoff=False, step_signoff=True)
    assert _complete(client, iid, n["1.1"]).status_code == 200

    nc = client.post(
        f"/api/procedure-instances/{iid}/steps/{n['1.1']}/nc",
        json={"title": "Leak rate over limit", "priority": "high"},
    )
    assert nc.status_code == 201, nc.text

    r = _signoff(client, iid, n["1.1"])
    assert r.status_code == 400
    assert _status(client, iid, n["1.1"]) == "awaiting_signoff"


def test_document_offers_signoff_for_awaiting_step(client):
    iid, n = _cut(client, op_signoff=False, step_signoff=True)
    _complete(client, iid, n["1.1"])
    doc = client.get(f"/api/procedure-instances/{iid}/document").json()
    step = next(s for op in doc["ops"] for s in op["steps"] if s["order"] == n["1.1"])
    assert step["status"] == "awaiting_signoff"
    assert step["requires_signoff"] is True
