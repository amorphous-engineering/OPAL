"""Regression tests for issue #47 — stored XSS via inline onclick handlers.

User-controlled strings rendered into inline JS (onclick attributes, script
blocks) must go through ``| tojson``, never manual quote escaping. The old
``replace("'", "\\'")`` idiom left backslashes untouched, so a field ending
in ``\\`` escaped the JS string's closing quote and let the next field run
as code — autoescaping does not prevent this, because the HTML parser
decodes ``&#39;`` back to ``'`` before the JS is parsed.

These tests store hostile field values, render the pages, and assert the
payloads come back inert AND intact (the handlers still receive the exact
stored values).
"""

import json
import re

from fastapi.testclient import TestClient

# Defeats the old idiom: quotes for the naive case, a trailing backslash to
# escape the closing quote, and code for the next field to complete.
BREAKOUT_REFDES = "R1'); alert(1); //\\"
BREAKOUT_NOTES = ");alert(document.cookie);//"

JSON_STRING = r'("(?:[^"\\]|\\.)*")'


def _create_part(client: TestClient, name: str) -> dict:
    resp = client.post("/api/parts", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_bom_edit_onclick_payload_is_inert_and_roundtrips(web_client: TestClient) -> None:
    assembly = _create_part(web_client, "XSS Assembly")
    component = _create_part(web_client, "<script>alert('pwned')</script>")
    resp = web_client.post(
        f"/api/bom/assemblies/{assembly['id']}",
        json={
            "component_id": component["id"],
            "quantity": 2,
            "reference_designator": BREAKOUT_REFDES,
            "notes": BREAKOUT_NOTES,
        },
    )
    assert resp.status_code == 201, resp.text

    page = web_client.get(f"/parts/{assembly['id']}")
    assert page.status_code == 200
    html = page.text

    # The component name renders entity-escaped, never as live markup.
    assert "<script>alert(" not in html
    assert "&lt;script&gt;alert" in html

    # The editBomLine args are JSON strings that round-trip to the stored
    # values: escaped (no breakout) and intact (working EDIT handler).
    match = re.search(rf"editBomLine\(\d+, [\d.]+, {JSON_STRING}, {JSON_STRING}\)", html)
    assert match, "editBomLine onclick missing or args not JSON-encoded"
    assert json.loads(match.group(1)) == BREAKOUT_REFDES
    assert json.loads(match.group(2)) == BREAKOUT_NOTES
    # No raw single quote survives inside the handler's argument list.
    assert "'" not in match.group(0)


def test_no_tojson_inside_double_quoted_event_attributes() -> None:
    """| tojson output is double-quoted JSON, so inside a DOUBLE-quoted event
    attribute the first quote terminates the attribute — dead handler at best
    (the broken ATTACH/ISSUE buttons), attribute injection at worst (#47).
    Event attributes that interpolate tojson must be single-quoted."""
    from pathlib import Path

    import opal.web

    templates = Path(opal.web.__file__).parent / "templates"
    pattern = re.compile(r'\bon[a-z]+="[^"]*\|\s*tojson')
    offenders = [
        f"{path}:{i}"
        for path in templates.rglob("*.html")
        for i, line in enumerate(path.read_text().splitlines(), 1)
        if pattern.search(line)
    ]
    assert not offenders, f"tojson inside double-quoted event attribute: {offenders}"


def test_confirm_btn_message_is_json_escaped() -> None:
    """Issue #55 — confirm_btn interpolates its args into inline JS."""
    from opal.web.routes import templates

    message = "Delete 'this' \\ that?"
    action = "/api/parts/1'); alert(1); //"
    html = templates.env.from_string(
        '{% import "opalkit/_macros.html" as ok %}'
        "{{ ok.confirm_btn('DELETE', message=message, action=action, redirect='/parts') }}"
    ).render(message=message, action=action)

    confirm = re.search(rf"confirm\({JSON_STRING}\)", html)
    assert confirm, "confirm() argument not JSON-encoded"
    assert json.loads(confirm.group(1)) == message
    fetch = re.search(rf"fetch\({JSON_STRING},", html)
    assert fetch, "fetch() URL not JSON-encoded"
    assert json.loads(fetch.group(1)) == action
    # A raw quote from message/action would terminate the single-quoted
    # attribute early, cutting off the tail of the handler.
    onclick = re.search(r"onclick='([^']*)'", html)
    assert onclick and "window.location.href" in onclick.group(1)


def test_procedure_clone_prompt_is_json_escaped(web_client: TestClient) -> None:
    name = "Proc \\';alert(1);//"
    resp = web_client.post("/api/procedures", json={"name": name})
    assert resp.status_code == 201, resp.text

    page = web_client.get(f"/procedures/{resp.json()['id']}")
    assert page.status_code == 200

    match = re.search(
        rf"prompt\('Enter name for the cloned procedure:', {JSON_STRING}\)", page.text
    )
    assert match, "clone prompt missing or default not JSON-encoded"
    assert json.loads(match.group(1)) == f"Copy of {name}"
