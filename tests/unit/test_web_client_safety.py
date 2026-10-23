"""Static guards over the web client source (frontend/src).

- XSS: Svelte escapes every text interpolation; the only way to emit live
  markup is ``{@html}``. Each use must pass through the sanitizing
  ``markdown()`` renderer (frontend/src/lib/markdown.ts, DOMPurify) or an
  explicit ``sanitize()`` call — never a raw user string.
- Register rule (exit 8): no emoji or pictographs in the interface — state
  words in state colors carry state. Arrows, box-drawing rules and geometric
  chevrons are typography and stay legal.

The vendored shadcn-svelte primitives (components/ui) are excluded.
"""

import re
from pathlib import Path

CLIENT_SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"
VENDORED = CLIENT_SRC / "lib" / "components" / "ui"

PICTOGRAPHS = re.compile(
    "["
    "☀-⛿"  # misc symbols
    "✀-➿"  # dingbats
    "⬀-⯿"  # misc symbols and arrows
    "️"  # emoji variation selector
    "\U0001f000-\U0001faff"  # emoji
    "]"
)
RAW_HTML = re.compile(r"\{@html\s+(?!(?:markdown|sanitize)\()")


def _sources(*suffixes: str) -> list[Path]:
    return sorted(
        p
        for p in CLIENT_SRC.rglob("*")
        if p.is_file() and p.suffix in suffixes and VENDORED not in p.parents
    )


def test_client_source_exists() -> None:
    assert _sources(".svelte"), "frontend/src not found — layout changed?"


def test_raw_html_only_through_sanitizer() -> None:
    offenders = [
        f"{path.relative_to(CLIENT_SRC)}:{i}: {line.strip()[:100]}"
        for path in _sources(".svelte")
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if RAW_HTML.search(line)
    ]
    assert not offenders, "{@html} without markdown()/sanitize():\n" + "\n".join(offenders)


def test_client_carries_no_pictographs() -> None:
    offenders = [
        f"{path.relative_to(CLIENT_SRC)}:{i}: {line.strip()[:80]}"
        for path in _sources(".svelte", ".ts", ".css", ".html")
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if PICTOGRAPHS.search(line)
    ]
    assert not offenders, "pictographs found:\n" + "\n".join(offenders)


# Radius is one knob: editing --radius in layout.css alone changes every corner, so
# OPAL's own code may only use the token classes (rounded-sm/md/lg/xl, side variants).
BAD_RADIUS = re.compile(r"(?<![\w-])(?:rounded(?![\w-])|rounded-(?:[a-z]{1,2}-)?(?:none|\[))")


def test_radius_comes_from_tokens() -> None:
    offenders = [
        f"{path.relative_to(CLIENT_SRC)}:{i}: {line.strip()[:100]}"
        for path in _sources(".svelte", ".ts")
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if BAD_RADIUS.search(line)
    ]
    assert not offenders, "rounded-none / rounded-[..] / bare rounded:\n" + "\n".join(offenders)


def test_theme_radius_tokens_derive_from_radius() -> None:
    css = (CLIENT_SRC / "routes" / "layout.css").read_text(encoding="utf-8")
    theme = css[css.index("@theme inline") :]
    tokens = re.findall(r"^\s*(--radius-\w+)\s*:\s*([^;]+);", theme, re.M)
    assert {"--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"} <= {n for n, _ in tokens}
    bad = [f"{n}: {v}" for n, v in tokens if "var(--radius)" not in v]
    assert not bad, "radius tokens not derived from var(--radius): " + "; ".join(bad)


ARBITRARY_TEXT = re.compile(r"\btext-\[([0-9.]+(?:px|rem|em))\]")
# Printed artwork keeps its paper sizes; screens use only the four-size ramp.
PRINT_ARTWORK = ("routes/(print)/", "routes/(report)/", "lib/components/labels/", "PartTag.svelte")


def test_screens_use_only_the_type_ramp() -> None:
    offenders = [
        f"{rel}:{i}: {m.group(0)}"
        for path in _sources(".svelte", ".ts")
        if not any(a in (rel := str(path.relative_to(CLIENT_SRC))) for a in PRINT_ARTWORK)
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        for m in ARBITRARY_TEXT.finditer(line)
    ]
    assert not offenders, "arbitrary font sizes (use text-xs/sm/lg/2xl):\n" + "\n".join(offenders)


def test_vendored_arbitrary_font_sizes_map_to_tokens() -> None:
    css = (CLIENT_SRC / "routes" / "layout.css").read_text(encoding="utf-8")
    used = {
        m.group(1)
        for path in VENDORED.rglob("*.svelte")
        for m in ARBITRARY_TEXT.finditer(path.read_text(encoding="utf-8"))
    }
    unmapped = sorted(v for v in used if f".text-\\[{v.replace('.', '\\.')}\\]" not in css)
    assert not unmapped, "vendored font sizes not mapped to a ramp token in layout.css: " + ", ".join(
        unmapped
    )
