"""Template authoring API: insert-after, move, duplicate, delete renumbering,
workcenter on steps, explicit-null clears, image reorder and the draft view."""

import pytest


@pytest.fixture
def proc(client):
    return client.post("/api/procedures", json={"name": "Authoring"}).json()["id"]


def add(client, pid, title, **kw):
    r = client.post(f"/api/procedures/{pid}/steps", json={"title": title, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def draft(client, pid):
    r = client.get(f"/api/procedures/{pid}/draft")
    assert r.status_code == 200, r.text
    return r.json()["steps"]


def numbers(client, pid):
    return [(s["step_number"], s["title"]) for s in draft(client, pid)]


def build(client, pid):
    """OP1 [a, b], OP2 [c]."""
    op1 = add(client, pid, "OP one")
    op2 = add(client, pid, "OP two")
    a = add(client, pid, "a", parent_step_id=op1["id"])
    b = add(client, pid, "b", parent_step_id=op1["id"])
    c = add(client, pid, "c", parent_step_id=op2["id"])
    return op1, op2, a, b, c


def test_draft_is_document_order_with_children(client, proc):
    build(client, proc)
    assert numbers(client, proc) == [
        ("1", "OP one"),
        ("1.1", "a"),
        ("1.2", "b"),
        ("2", "OP two"),
        ("2.1", "c"),
    ]
    assert [s["order"] for s in draft(client, proc)] == [1, 2, 3, 4, 5]


def test_draft_carries_images_kit_and_dependencies(client, proc):
    op1, op2, a, _b, _c = build(client, proc)
    part = client.post("/api/parts", json={"name": "Screw", "category": "hardware"}).json()
    client.post(
        f"/api/procedures/{proc}/steps/{a['id']}/kit",
        json={"part_id": part["id"], "quantity_required": 4, "usage_type": "consume"},
    )
    client.post(
        f"/api/procedures/{proc}/steps/{a['id']}/images",
        files={"file": ("x.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        data={"caption": "cap"},
    )
    client.put(
        f"/api/procedures/{proc}/steps/{op2['id']}/dependencies", json={"depends_on": [op1["id"]]}
    )
    by_id = {s["id"]: s for s in draft(client, proc)}
    assert by_id[a["id"]]["step_kit"][0]["part_name"] == "Screw"
    assert by_id[a["id"]]["step_kit"][0]["quantity_required"] == 4
    assert by_id[a["id"]]["images"][0]["caption"] == "cap"
    assert by_id[op2["id"]]["depends_on"] == [op1["id"]]


def test_insert_after_substep(client, proc):
    _op1, _op2, a, _b, _c = build(client, proc)
    add(client, proc, "a2", parent_step_id=a["parent_step_id"], after_step_id=a["id"])
    assert numbers(client, proc) == [
        ("1", "OP one"),
        ("1.1", "a"),
        ("1.2", "a2"),
        ("1.3", "b"),
        ("2", "OP two"),
        ("2.1", "c"),
    ]


def test_insert_after_op_as_first_substep_and_as_next_op(client, proc):
    op1, _op2, *_ = build(client, proc)
    add(client, proc, "first", parent_step_id=op1["id"], after_step_id=op1["id"])
    add(client, proc, "between", after_step_id=op1["id"])
    assert numbers(client, proc) == [
        ("1", "OP one"),
        ("1.1", "first"),
        ("1.2", "a"),
        ("1.3", "b"),
        ("2", "between"),
        ("3", "OP two"),
        ("3.1", "c"),
    ]


def test_insert_after_unknown_step_404(client, proc):
    r = client.post(f"/api/procedures/{proc}/steps", json={"title": "x", "after_step_id": 99999})
    assert r.status_code == 404


def test_delete_op_renumbers_and_drops_children(client, proc):
    op1, *_ = build(client, proc)
    assert client.delete(f"/api/procedures/{proc}/steps/{op1['id']}").status_code == 204
    assert numbers(client, proc) == [("1", "OP two"), ("1.1", "c")]
    assert [s["order"] for s in draft(client, proc)] == [1, 2]


def test_delete_substep_renumbers_siblings(client, proc):
    _op1, _op2, a, *_ = build(client, proc)
    client.delete(f"/api/procedures/{proc}/steps/{a['id']}")
    assert numbers(client, proc)[:2] == [("1", "OP one"), ("1.1", "b")]


def test_move_substep_within_op(client, proc):
    op1, _op2, a, b, _c = build(client, proc)
    r = client.post(
        f"/api/procedures/{proc}/steps/{b['id']}/move",
        json={"parent_step_id": op1["id"], "index": 0},
    )
    assert r.status_code == 200
    assert numbers(client, proc)[:3] == [("1", "OP one"), ("1.1", "b"), ("1.2", "a")]


def test_move_substep_between_ops(client, proc):
    _op1, op2, a, *_ = build(client, proc)
    client.post(
        f"/api/procedures/{proc}/steps/{a['id']}/move",
        json={"parent_step_id": op2["id"], "index": 1},
    )
    assert numbers(client, proc) == [
        ("1", "OP one"),
        ("1.1", "b"),
        ("2", "OP two"),
        ("2.1", "c"),
        ("2.2", "a"),
    ]


def test_move_op_down(client, proc):
    op1, *_ = build(client, proc)
    client.post(
        f"/api/procedures/{proc}/steps/{op1['id']}/move", json={"parent_step_id": None, "index": 1}
    )
    assert numbers(client, proc) == [
        ("1", "OP two"),
        ("1.1", "c"),
        ("2", "OP one"),
        ("2.1", "a"),
        ("2.2", "b"),
    ]


def test_move_op_with_children_under_another_is_refused(client, proc):
    op1, op2, *_ = build(client, proc)
    r = client.post(
        f"/api/procedures/{proc}/steps/{op1['id']}/move",
        json={"parent_step_id": op2["id"], "index": 0},
    )
    assert r.status_code == 400


def test_demote_leaf_op_drops_dependencies(client, proc):
    op1, op2, _a, _b, _c = build(client, proc)
    leaf = add(client, proc, "leaf")
    client.put(
        f"/api/procedures/{proc}/steps/{leaf['id']}/dependencies", json={"depends_on": [op1["id"]]}
    )
    r = client.post(
        f"/api/procedures/{proc}/steps/{leaf['id']}/move",
        json={"parent_step_id": op2["id"], "index": 0},
    )
    assert r.status_code == 200
    s = {x["id"]: x for x in draft(client, proc)}[leaf["id"]]
    assert s["step_number"] == "2.1" and s["level"] == 1 and s["depends_on"] == []


def test_promote_substep_to_op(client, proc):
    _op1, _op2, a, *_ = build(client, proc)
    client.post(
        f"/api/procedures/{proc}/steps/{a['id']}/move", json={"parent_step_id": None, "index": 1}
    )
    assert numbers(client, proc)[:4] == [("1", "OP one"), ("1.1", "b"), ("2", "a"), ("3", "OP two")]


def test_toggle_contingency_regroups_and_renumbers(client, proc):
    op1, *_ = build(client, proc)
    r = client.patch(f"/api/procedures/{proc}/steps/{op1['id']}", json={"is_contingency": True})
    assert r.status_code == 200
    assert numbers(client, proc) == [
        ("1", "OP two"),
        ("1.1", "c"),
        ("C1", "OP one"),
        ("C1.1", "a"),
        ("C1.2", "b"),
    ]
    assert all(s["is_contingency"] for s in draft(client, proc)[2:])


def test_substep_contingency_follows_op(client, proc):
    _op1, _op2, a, *_ = build(client, proc)
    r = client.patch(f"/api/procedures/{proc}/steps/{a['id']}", json={"is_contingency": True})
    assert r.status_code == 400


def test_duplicate_substep(client, proc):
    _op1, _op2, a, *_ = build(client, proc)
    part = client.post("/api/parts", json={"name": "Nut", "category": "hardware"}).json()
    client.post(
        f"/api/procedures/{proc}/steps/{a['id']}/kit",
        json={"part_id": part["id"], "quantity_required": 2, "usage_type": "tooling"},
    )
    client.patch(
        f"/api/procedures/{proc}/steps/{a['id']}",
        json={
            "required_data_schema": {"fields": [{"name": "t", "type": "number"}]},
            "callouts": [{"kind": "caution", "text": "hot"}],
        },
    )
    r = client.post(f"/api/procedures/{proc}/steps/{a['id']}/duplicate")
    assert r.status_code == 201
    steps = draft(client, proc)
    assert [s["step_number"] for s in steps] == ["1", "1.1", "1.2", "1.3", "2", "2.1"]
    copy = steps[2]
    assert (
        copy["id"] != a["id"]
        and copy["title"] == "a"
        and copy["callouts"] == [{"kind": "caution", "text": "hot"}]
    )
    assert copy["step_kit"][0]["usage_type"] == "tooling"
    assert copy["required_data_schema"]["fields"][0]["name"] == "t"


def test_duplicate_op_takes_substeps(client, proc):
    op1, *_ = build(client, proc)
    r = client.post(f"/api/procedures/{proc}/steps/{op1['id']}/duplicate")
    assert r.status_code == 201
    assert numbers(client, proc) == [
        ("1", "OP one"),
        ("1.1", "a"),
        ("1.2", "b"),
        ("2", "OP one"),
        ("2.1", "a"),
        ("2.2", "b"),
        ("3", "OP two"),
        ("3.1", "c"),
    ]


def test_step_workcenter_round_trip_and_clear(client, proc):
    wc = client.post("/api/workcenters", json={"name": "Bench", "code": "B1"}).json()
    s = add(client, proc, "with wc", workcenter_id=wc["id"])
    assert s["workcenter_id"] == wc["id"]
    r = client.patch(f"/api/procedures/{proc}/steps/{s['id']}", json={"title": "renamed"})
    assert r.json()["workcenter_id"] == wc["id"]  # untouched when absent
    r = client.patch(f"/api/procedures/{proc}/steps/{s['id']}", json={"workcenter_id": None})
    assert r.json()["workcenter_id"] is None
    assert (
        client.patch(
            f"/api/procedures/{proc}/steps/{s['id']}", json={"workcenter_id": 99999}
        ).status_code
        == 404
    )


def test_explicit_null_clears_text_duration_and_schema(client, proc):
    s = add(
        client,
        proc,
        "full",
        instructions="text",
        estimated_duration_minutes=5,
        required_data_schema={"fields": [{"name": "x", "type": "text"}]},
    )
    r = client.patch(
        f"/api/procedures/{proc}/steps/{s['id']}",
        json={
            "instructions": None,
            "estimated_duration_minutes": None,
            "required_data_schema": None,
        },
    )
    body = r.json()
    assert body["instructions"] is None
    assert body["estimated_duration_minutes"] is None
    assert body["required_data_schema"] is None


def test_reorder_step_images(client, proc):
    s = add(client, proc, "imgs")
    ids = []
    for name in ("one", "two", "three"):
        r = client.post(
            f"/api/procedures/{proc}/steps/{s['id']}/images",
            files={"file": (f"{name}.png", b"\x89PNG\r\n\x1a\n", "image/png")},
            data={"caption": name},
        )
        ids.append(r.json()["id"])
    r = client.post(
        f"/api/procedures/{proc}/steps/{s['id']}/images/reorder",
        json={"image_ids": [ids[2], ids[0], ids[1]]},
    )
    assert r.status_code == 200
    assert [i["caption"] for i in r.json()] == ["three", "one", "two"]
    assert [i["caption"] for i in draft(client, proc)[0]["images"]] == ["three", "one", "two"]
    bad = client.post(
        f"/api/procedures/{proc}/steps/{s['id']}/images/reorder", json={"image_ids": ids[:2]}
    )
    assert bad.status_code == 400


def test_draft_404_for_missing_procedure(client):
    assert client.get("/api/procedures/99999/draft").status_code == 404


def test_edits_make_unpublished_changes(client, proc):
    build(client, proc)
    client.post(f"/api/procedures/{proc}/publish")
    assert client.get(f"/api/procedures/{proc}").json()["unpublished_changes"] is False
    s = draft(client, proc)[1]
    client.patch(f"/api/procedures/{proc}/steps/{s['id']}", json={"title": "changed"})
    assert client.get(f"/api/procedures/{proc}").json()["unpublished_changes"] is True


# ============ callouts ============

MIXED = [
    {"kind": "info", "text": "Torque in N.m."},
    {"kind": "caution", "text": "Wear gloves."},
    {"kind": "info", "text": "Second note."},
]


def callouts_of(client, pid, title):
    return next(s["callouts"] for s in draft(client, pid) if s["title"] == title)


def test_callouts_default_to_empty_list(client, proc):
    add(client, proc, "plain")
    assert callouts_of(client, proc, "plain") == []


def test_multiple_callouts_round_trip_in_author_order(client, proc):
    step = add(client, proc, "mixed", callouts=MIXED)
    assert step["callouts"] == MIXED
    assert callouts_of(client, proc, "mixed") == MIXED


def test_patch_callouts_replaces_the_list(client, proc):
    step = add(client, proc, "s", callouts=MIXED)
    r = client.patch(
        f"/api/procedures/{proc}/steps/{step['id']}",
        json={"callouts": [{"kind": "info", "text": "only"}]},
    )
    assert r.status_code == 200, r.text
    assert callouts_of(client, proc, "s") == [{"kind": "info", "text": "only"}]
    # Absent key leaves the list alone.
    client.patch(f"/api/procedures/{proc}/steps/{step['id']}", json={"title": "s"})
    assert callouts_of(client, proc, "s") == [{"kind": "info", "text": "only"}]
    client.patch(f"/api/procedures/{proc}/steps/{step['id']}", json={"callouts": []})
    assert callouts_of(client, proc, "s") == []


def test_empty_callout_text_is_dropped_and_text_stripped(client, proc):
    step = add(
        client,
        proc,
        "s",
        callouts=[
            {"kind": "caution", "text": "  "},
            {"kind": "info", "text": "  keep  "},
        ],
    )
    assert step["callouts"] == [{"kind": "info", "text": "keep"}]


def test_unknown_callout_kind_is_refused(client, proc):
    r = client.post(
        f"/api/procedures/{proc}/steps",
        json={"title": "s", "callouts": [{"kind": "danger", "text": "x"}]},
    )
    assert r.status_code == 422


def test_snapshot_writes_callouts_and_restore_keeps_them(client, proc):
    add(client, proc, "s", callouts=MIXED)
    assert client.post(f"/api/procedures/{proc}/publish").status_code in (200, 201)
    versions = client.get(f"/api/procedures/{proc}/versions").json()
    detail = client.get(f"/api/procedures/versions/{versions[0]['id']}").json()
    step = detail["content"]["steps"][0]
    assert step["callouts"] == MIXED
    assert "caution" not in step


def test_diff_reads_legacy_caution_as_callout(client, proc, db_session):
    from sqlalchemy.orm.attributes import flag_modified

    from opal.db.models.procedure import ProcedureVersion

    step = add(client, proc, "s", callouts=[{"kind": "caution", "text": "HOT"}])
    client.post(f"/api/procedures/{proc}/publish")
    client.patch(
        f"/api/procedures/{proc}/steps/{step['id']}",
        json={"callouts": [{"kind": "caution", "text": "HOT"}, {"kind": "info", "text": "n"}]},
    )
    client.post(f"/api/procedures/{proc}/publish")
    v1, v2 = db_session.query(ProcedureVersion).order_by(ProcedureVersion.version_number).all()
    v1.content = {
        **v1.content,
        "steps": [
            {**{k: v for k, v in s.items() if k != "callouts"}, "caution": "HOT"}
            for s in v1.content["steps"]
        ],
    }
    flag_modified(v1, "content")
    db_session.flush()
    r = client.get(f"/api/procedures/{proc}/versions/{v1.id}/diff/{v2.id}")
    assert r.status_code == 200, r.text
    (sd,) = [s for s in r.json()["steps"] if s["status"] != "unchanged"]
    assert sd["changed_fields"] == ["callouts"]
    assert sd["changes"]["callouts"]["a"] == [{"kind": "caution", "text": "HOT"}]
    # Identical content in legacy shape compares unchanged.
    r = client.get(f"/api/procedures/{proc}/versions/{v1.id}/diff/{v1.id}")
    assert r.json()["modified"] == 0
