"""Amendment 6: procurement declaration and section relevance.

The declaration (make | buy | both) governs which part-page sections
expect content. Irrelevant empty sections are absent; data always
renders; an empty relevant section is exactly one line.
"""


def _create(client, **kwargs):
    payload = {"name": "Procurement Part", "tier": 1, **kwargs}
    resp = client.post("/api/parts", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_defaults_buy_when_external_pn_given(web_client):
    part = _create(web_client, name="Lock Washer", external_pn="91255A101")
    assert part["procurement"] == "buy"


def test_create_defaults_make_without_external_pn(web_client):
    part = _create(web_client, name="Engine Assembly")
    assert part["procurement"] == "make"


def test_explicit_procurement_overrides_heuristic(web_client):
    part = _create(web_client, name="Machined Casting", external_pn="CAST-44", procurement="both")
    assert part["procurement"] == "both"


def test_patch_procurement(web_client):
    part = _create(web_client, name="Patched Part")
    resp = web_client.patch(f"/api/parts/{part['id']}", json={"procurement": "buy"})
    assert resp.status_code == 200
    assert resp.json()["procurement"] == "buy"

    bad = web_client.patch(f"/api/parts/{part['id']}", json={"procurement": "steal"})
    assert bad.status_code == 422


def _detail(client, part: dict) -> dict:
    resp = client.get(f"/api/parts/{part['id']}/detail")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_buy_part_expects_suppliers_not_bom(web_client):
    """Exit criterion 6: the lock washer."""
    part = _create(web_client, name="Lock Washer", external_pn="91255A101")
    detail = _detail(web_client, part)
    assert detail["expects"] == {"bom": False, "suppliers": True, "po_lines": True}
    assert detail["bom"] == []
    assert detail["suppliers"] == []


def test_make_part_expects_bom_not_suppliers(web_client):
    """Exit criterion 7: the engine assembly."""
    part = _create(web_client, name="Engine Assembly")
    detail = _detail(web_client, part)
    assert detail["expects"] == {"bom": True, "suppliers": False, "po_lines": False}


def test_data_wins_bom_on_buy_part(web_client):
    """Exit criterion 8: a BOM edge forced onto a buy part is still returned.

    Expectation is declared intent only; the client renders any collection
    that has rows regardless of ``expects``.
    """
    washer = _create(web_client, name="Washer Kit", external_pn="91255A102")
    component = _create(web_client, name="Split Washer", external_pn="91255A103")
    resp = web_client.post(
        f"/api/bom/assemblies/{washer['id']}",
        json={"component_id": component["id"], "quantity": 4},
    )
    assert resp.status_code in (200, 201), resp.text

    detail = _detail(web_client, washer)
    assert detail["expects"]["bom"] is False
    assert [(line["component_name"], line["quantity"]) for line in detail["bom"]] == [
        ("Split Washer", 4)
    ]
    assert detail["bom"][0]["component_internal_pn"] == component["internal_pn"]


def test_expectation_follows_procurement_edits(web_client):
    part = _create(web_client, name="Flip Part")
    assert _detail(web_client, part)["expects"]["suppliers"] is False
    web_client.patch(f"/api/parts/{part['id']}", json={"procurement": "buy"})
    assert _detail(web_client, part)["expects"] == {
        "bom": False,
        "suppliers": True,
        "po_lines": True,
    }


def test_import_honors_explicit_procurement(web_client):
    resp = web_client.post(
        "/api/parts/import",
        json={
            "rows": [
                {
                    "name": "Imported Declared",
                    "external_pn": "IMP-1",
                    "tier": 1,
                    "procurement": "both",
                },
                {"name": "Imported Heuristic", "external_pn": "IMP-2", "tier": 1},
            ]
        },
    )
    assert resp.status_code in (200, 201), resp.text

    listing = web_client.get("/api/parts", params={"search": "Imported"}).json()
    by_name = {p["name"]: p["procurement"] for p in listing["items"]}
    assert by_name["Imported Declared"] == "both"
    assert by_name["Imported Heuristic"] == "buy"


def test_both_expects_every_section(web_client):
    part = _create(web_client, name="Make And Buy", procurement="both")
    assert _detail(web_client, part)["expects"] == {
        "bom": True,
        "suppliers": True,
        "po_lines": True,
    }
