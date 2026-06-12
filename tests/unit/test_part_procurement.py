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


def test_buy_part_page_has_no_bom_but_one_line_suppliers(web_client):
    """Exit criterion 6: the lock washer."""
    part = _create(web_client, name="Lock Washer", external_pn="91255A101")
    page = web_client.get(f"/parts/{part['id']}")
    assert page.status_code == 200
    assert ">BOM<" not in page.text
    assert ">SUPPLIERS<" in page.text
    assert ">PO LINES<" in page.text
    # One line with the add affordance, never a header bar over a box
    suppliers_line = page.text[page.text.index(">SUPPLIERS<") - 200 : page.text.index(">SUPPLIERS<") + 300]
    assert "empty-line" in suppliers_line
    assert "+ ADD" in suppliers_line
    assert page.text.count('class="panel panel-ledger"') == 0


def test_make_part_page_has_no_supplier_sections(web_client):
    """Exit criterion 7: the engine assembly."""
    part = _create(web_client, name="Engine Assembly")
    page = web_client.get(f"/parts/{part['id']}")
    assert page.status_code == 200
    assert ">BOM<" in page.text
    assert ">SUPPLIERS<" not in page.text
    assert ">PO LINES<" not in page.text


def test_data_wins_bom_on_buy_part(web_client):
    """Exit criterion 8: a BOM edge forced onto a buy part renders."""
    washer = _create(web_client, name="Washer Kit", external_pn="91255A102")
    component = _create(web_client, name="Split Washer", external_pn="91255A103")
    resp = web_client.post(
        f"/api/bom/assemblies/{washer['id']}",
        json={"component_id": component["id"], "quantity": 4},
    )
    assert resp.status_code in (200, 201), resp.text

    page = web_client.get(f"/parts/{washer['id']}")
    assert ">BOM<" in page.text
    # Populated: the section is a panel with a headed table, not a line
    bom_region = page.text[page.text.index(">BOM<") - 300 : page.text.index(">BOM<") + 200]
    assert "panel-ledger" in bom_region
    assert page.text.count("Split Washer") >= 1


def test_every_empty_section_is_exactly_one_line(web_client):
    """Exit criterion 9: empty sections are one line each, on any part."""
    make_part = _create(web_client, name="Bare Make Part")
    page = web_client.get(f"/parts/{make_part['id']}")
    # make: BOM, STOCK, WHERE USED, PROCEDURE USE, CONSUMED, REQUIREMENTS, TESTS
    assert page.text.count('class="empty-line"') == 7

    buy_part = _create(web_client, name="Bare Buy Part", external_pn="MC-1")
    page2 = web_client.get(f"/parts/{buy_part['id']}")
    # buy: SUPPLIERS, PO LINES, STOCK, WHERE USED, PROCEDURE USE, REQUIREMENTS,
    # TESTS, CONSUMED — BOM absent
    assert page2.text.count('class="empty-line"') == 8
    assert page2.text.count('class="panel panel-ledger"') == 0


def test_import_honors_explicit_procurement(web_client):
    resp = web_client.post(
        "/api/parts/import",
        json={
            "rows": [
                {"name": "Imported Declared", "external_pn": "IMP-1", "tier": 1, "procurement": "both"},
                {"name": "Imported Heuristic", "external_pn": "IMP-2", "tier": 1},
            ]
        },
    )
    assert resp.status_code in (200, 201), resp.text

    listing = web_client.get("/api/parts", params={"search": "Imported"}).json()
    by_name = {p["name"]: p["procurement"] for p in listing["items"]}
    assert by_name["Imported Declared"] == "both"
    assert by_name["Imported Heuristic"] == "buy"


def test_both_renders_all_relevant_sections(web_client):
    part = _create(web_client, name="Make And Buy", procurement="both")
    page = web_client.get(f"/parts/{part['id']}")
    assert ">BOM<" in page.text
    assert ">SUPPLIERS<" in page.text
    assert ">PO LINES<" in page.text
