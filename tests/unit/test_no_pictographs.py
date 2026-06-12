"""Register rule (exit 8): no emoji or pictographs in the interface — state
words in state colors carry state. Arrows, box-drawing rules, and geometric
chevrons are typography and stay legal."""

import re
from pathlib import Path

import opal.web

# Dingbats, misc symbols, emoji blocks, and the emoji variation selector —
# the pictograph register. Typography is excluded: arrows (2190-21FF), misc
# technical (2300-23FF), box drawing (2500-257F), geometric shapes (25A0-25FF).
PICTOGRAPHS = re.compile(
    "["
    "☀-⛿"  # misc symbols
    "✀-➿"  # dingbats
    "⬀-⯿"  # misc symbols and arrows
    "️"  # emoji variation selector
    "\U0001f000-\U0001faff"  # emoji
    "]"
)


def test_templates_and_js_carry_no_pictographs():
    web_root = Path(opal.web.__file__).parent
    offenders = []
    scanned = 0
    for pattern in ("templates/**/*.html", "static/js/**/*.js"):
        for path in sorted(web_root.glob(pattern)):
            scanned += 1
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if PICTOGRAPHS.search(line):
                    offenders.append(f"{path.relative_to(web_root)}:{lineno}: {line.strip()[:80]}")
    assert scanned > 0, "nothing scanned — web package layout changed?"
    assert not offenders, "pictographs found:\n" + "\n".join(offenders)
