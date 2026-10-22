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
