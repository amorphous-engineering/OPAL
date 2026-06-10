"""Server-side lint underline rendering for requirement statements.

Turns a statement plus spanned LintFindings into HTML where each flagged
run of text is wrapped in <span class="lint-block|lint-warn" title="...">.
Overlapping spans merge per character — block severity wins the class,
tooltips accumulate every covering finding.
"""

from markupsafe import Markup, escape

from opal.se.lint import LintFinding


def statement_lint_html(statement: str, findings: list[LintFinding]) -> Markup:
    """Escape the statement and underline every spanned finding."""
    spanned = [f for f in findings if f.span is not None]
    if not spanned or not statement:
        return Markup(escape(statement))

    # Per-character set of covering findings, then group equal consecutive sets.
    marks: list[frozenset[int]] = [frozenset()] * len(statement)
    for i, finding in enumerate(spanned):
        start, end = finding.span
        for pos in range(max(start, 0), min(end, len(statement))):
            marks[pos] = marks[pos] | {i}

    parts: list[str] = []
    run_start = 0
    for pos in range(1, len(statement) + 1):
        if pos < len(statement) and marks[pos] == marks[run_start]:
            continue
        text = escape(statement[run_start:pos])
        covering = marks[run_start]
        if covering:
            here = [spanned[i] for i in sorted(covering)]
            css = "lint-block" if any(f.severity == "block_baseline" for f in here) else "lint-warn"
            title = escape("; ".join(f"{f.rule}: {f.message}" for f in here))
            parts.append(f'<span class="{css}" title="{title}">{text}</span>')
        else:
            parts.append(str(text))
        run_start = pos

    return Markup("".join(parts))
