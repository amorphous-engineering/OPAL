"""Split lint-checked text into annotated runs for inline underlining.

The linters (opal.se.lint, opal.risks.lint) return findings with character
spans. Clients underline by rendering runs, so the span arithmetic lives
here once: overlapping spans merge per character — block severity wins the
`severity` of a run, and every covering finding rides along on it.
"""

from typing import Any

from opal.se.lint import LintFinding


def lint_segments(text: str, findings: list[LintFinding]) -> list[dict[str, Any]]:
    """Return ordered runs covering `text`: {text, severity, findings}.

    `severity` is "block" | "warn" | None (unflagged run); `findings` lists
    {rule, message} for every finding covering the run.
    """
    if not text:
        return []
    spanned = [f for f in findings if f.span is not None]
    if not spanned:
        return [{"text": text, "severity": None, "findings": []}]

    marks: list[frozenset[int]] = [frozenset()] * len(text)
    for i, finding in enumerate(spanned):
        start, end = finding.span  # type: ignore[misc]
        for pos in range(max(start, 0), min(end, len(text))):
            marks[pos] = marks[pos] | {i}

    segments: list[dict[str, Any]] = []
    run_start = 0
    for pos in range(1, len(text) + 1):
        if pos < len(text) and marks[pos] == marks[run_start]:
            continue
        covering = [spanned[i] for i in sorted(marks[run_start])]
        severity = None
        if covering:
            severity = "block" if any(f.severity.startswith("block") for f in covering) else "warn"
        segments.append(
            {
                "text": text[run_start:pos],
                "severity": severity,
                "findings": [{"rule": f.rule, "message": f.message} for f in covering],
            }
        )
        run_start = pos
    return segments
