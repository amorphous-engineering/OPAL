"""Tests for the native DYMO label PDF renderer (core/dymo_label.py)."""

from opal.core import dymo_label


def test_page_height_short_for_brief_content():
    assert dymo_label.page_height_in("SPX-D-0008", "E85", None) == 2.0


def test_page_height_long_for_full_meta_line():
    height = dymo_label.page_height_in(
        "SPX-F-0068",
        "-141 Silicone O-rings (Pack of 10)",
        "LOT-MCM-2606-B · OPAL-00063 · QTY: 8 PACK",
    )
    assert height == 3.5


def test_render_dymo_label_pdf_returns_valid_pdf_bytes():
    pdf = dymo_label.render_dymo_label_pdf("SPX-D-0008", "E85", None, "SPX-D-0008")
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 100


def test_render_dymo_label_pdf_with_meta():
    pdf = dymo_label.render_dymo_label_pdf(
        "SPX-F-0068",
        "-141 Silicone O-rings (Pack of 10)",
        "LOT-MCM-2606-B · OPAL-00063 · QTY: 8 PACK",
        "OPAL-00063",
    )
    assert pdf.startswith(b"%PDF")
