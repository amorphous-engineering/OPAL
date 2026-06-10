"""Drift guard: the docs lint-rules mirror must match the executable yaml.

src/opal/se/lint_rules.yaml is the executable truth; the copy under
docs/plans/se-module/ exists for review. The docs tree is gitignored, so CI
skips this; dev machines that carry the plans enforce the mirror.
"""

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
EXECUTABLE = REPO_ROOT / "src" / "opal" / "se" / "lint_rules.yaml"
MIRROR = REPO_ROOT / "docs" / "plans" / "se-module" / "lint-rules.yaml"


def _comparable(path: Path) -> list[dict]:
    rules = yaml.safe_load(path.read_text(encoding="utf-8"))["rules"]
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "severity": r["severity"],
            "terms": r.get("terms"),
            "warn_terms": r.get("warn_terms"),
            "bound_phrases": r.get("bound_phrases"),
        }
        for r in rules
    ]


@pytest.mark.skipif(not MIRROR.exists(), reason="docs/plans mirror not present (gitignored)")
def test_docs_mirror_matches_executable_rules():
    executable = _comparable(EXECUTABLE)
    mirror = _comparable(MIRROR)
    assert executable == mirror, (
        "lint-rules drift: src/opal/se/lint_rules.yaml is the executable truth — "
        "update the docs/plans/se-module/lint-rules.yaml mirror to match"
    )
