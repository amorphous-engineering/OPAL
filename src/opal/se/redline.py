"""Word-level redlines between requirement revisions.

difflib over word tokens (whitespace preserved as part of the stream so
reflowed text doesn't light up as a change wall). Two consumers: the web
revision-history partial renders HTML, MCP returns the raw segments.
"""

import re
from difflib import SequenceMatcher

from markupsafe import Markup, escape

_TOKEN = re.compile(r"\S+|\s+")


def redline_segments(old: str, new: str) -> list[dict[str, str]]:
    """Ordered segments: {op: equal|delete|insert, text}."""
    old_tokens = _TOKEN.findall(old or "")
    new_tokens = _TOKEN.findall(new or "")
    segments: list[dict[str, str]] = []

    def push(op: str, text: str) -> None:
        if not text:
            return
        if segments and segments[-1]["op"] == op:
            segments[-1]["text"] += text
        else:
            segments.append({"op": op, "text": text})

    matcher = SequenceMatcher(a=old_tokens, b=new_tokens, autojunk=False)
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            push("equal", "".join(old_tokens[a0:a1]))
        else:  # replace / delete / insert
            push("delete", "".join(old_tokens[a0:a1]))
            push("insert", "".join(new_tokens[b0:b1]))
    return segments


def redline_html(old: str, new: str) -> Markup:
    """Strike-old / highlight-new rendering of the segments."""
    parts: list[str] = []
    for seg in redline_segments(old, new):
        text = escape(seg["text"])
        if seg["op"] == "delete":
            parts.append(f'<del class="redline-del">{text}</del>')
        elif seg["op"] == "insert":
            parts.append(f'<ins class="redline-ins">{text}</ins>')
        else:
            parts.append(str(text))
    return Markup("".join(parts))
