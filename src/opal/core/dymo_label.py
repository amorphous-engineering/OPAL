"""Native PDF rendering for direct-print DYMO LabelManager 280 labels.

A separate render path from web/templates/label_dymo.html (the browser
print-dialog fallback) — reportlab keeps this dependency-light instead of
bundling a headless browser, at the cost of maintaining the layout twice.
Geometry (page presets, rotation direction, cross-tape budget) is carried
over from the HTML/CSS version, which was tuned against physical hardware;
keep the two in sync by hand if either changes.
"""

from io import BytesIO

from pystrich.datamatrix import DataMatrixEncoder
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

PAGE_WIDTH_IN = 0.4861  # 35pt native tape-width canvas, 12mm (max) D1 tape
_SHORT_PAGE_IN = 2.0
_LONG_PAGE_IN = 3.5
_PAGE_MARGIN_IN = 0.833  # fixed on both DYMO "Label" presets
_SHORT_PRINTABLE_IN = _SHORT_PAGE_IN - _PAGE_MARGIN_IN
_CROSS_TAPE_IN = 0.32  # printable width for 12mm tape, both presets
_DM_SIZE_IN = 0.32
_GAP_IN = 0.05
_PN_FONT = ("Courier-Bold", 8)
_NAME_FONT = ("Courier-Bold", 6.5)
_META_FONT = ("Courier-Bold", 5.5)


def _lines_and_fonts(
    pn: str, name: str, meta: str | None
) -> tuple[list[str], list[tuple[str, float]]]:
    lines = [pn, name]
    fonts = [_PN_FONT, _NAME_FONT]
    if meta:
        lines.append(meta)
        fonts.append(_META_FONT)
    return lines, fonts


def page_height_in(pn: str, name: str, meta: str | None) -> float:
    """Pick the shortest DYMO page preset that fits this label's content."""
    lines, fonts = _lines_and_fonts(pn, name, meta)
    widths_in = [
        canvas.Canvas(BytesIO()).stringWidth(text, font, size) / 72
        for text, (font, size) in zip(lines, fonts, strict=True)
    ]
    needed_in = _DM_SIZE_IN + _GAP_IN + max(widths_in) + _GAP_IN
    return _SHORT_PAGE_IN if needed_in <= _SHORT_PRINTABLE_IN else _LONG_PAGE_IN


def render_dymo_label_pdf(pn: str, name: str, meta: str | None, datamatrix_data: str) -> bytes:
    """Render a DYMO LabelManager 280 label as a print-ready PDF.

    datamatrix_data is the identifier encoded in the Data Matrix — the
    part number for a part label, the OPAL number for an inventory label.
    """
    page_h_in = page_height_in(pn, name, meta)
    page_w = PAGE_WIDTH_IN * inch
    page_h = page_h_in * inch

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_w, page_h))
    # The driver's native page is portrait (narrow = tape width, long =
    # feed direction); rotate +90deg so content reads correctly once the
    # tape is peeled off — confirmed against physical hardware.
    c.translate(page_w / 2, page_h / 2)
    c.rotate(90)

    lines, fonts = _lines_and_fonts(pn, name, meta)
    text_width_in = max(
        c.stringWidth(text, font, size) / 72 for text, (font, size) in zip(lines, fonts, strict=True)
    )
    content_width_in = _DM_SIZE_IN + _GAP_IN + text_width_in
    x0 = -(content_width_in * inch) / 2
    band_top = (_CROSS_TAPE_IN * inch) / 2

    # Data Matrix, flush left within the content block. Rendered via
    # pystrich's own image encoder rather than its `.matrix` attribute,
    # which turned out to be stale/wrong — get_pilimage() is the same
    # code path that produced the SVG confirmed scannable on hardware.
    dm_image = DataMatrixEncoder(datamatrix_data).get_pilimage(cellsize=4)
    c.drawImage(
        ImageReader(dm_image),
        x0,
        band_top - _DM_SIZE_IN * inch,
        width=_DM_SIZE_IN * inch,
        height=_DM_SIZE_IN * inch,
    )

    # Text stack, vertically split across the cross-tape band
    text_x = x0 + (_DM_SIZE_IN + _GAP_IN) * inch
    line_height_in = _CROSS_TAPE_IN / len(lines)
    for i, (text, (font_name, font_size)) in enumerate(zip(lines, fonts, strict=True)):
        baseline_y = band_top - (i + 0.8) * line_height_in * inch
        c.setFont(font_name, font_size)
        c.drawString(text_x, baseline_y, text)

    c.showPage()
    c.save()
    return buf.getvalue()
