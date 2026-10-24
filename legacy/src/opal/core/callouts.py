"""Step callouts: ordered CAUTION and INFO boxes attached to a procedure step."""

from typing import Any, Literal

from pydantic import BaseModel

CALLOUT_KINDS = ("caution", "info")


class Callout(BaseModel):
    """One callout box."""

    kind: Literal["caution", "info"]
    text: str


def normalize_callouts(value: Any) -> list[dict[str, str]]:
    """Validate kinds, strip text, drop entries with empty text. Order is kept."""
    out: list[dict[str, str]] = []
    for item in value or []:
        if isinstance(item, BaseModel):
            item = item.model_dump()
        if not isinstance(item, dict):
            raise ValueError("callout must be an object")
        kind = item.get("kind")
        if kind not in CALLOUT_KINDS:
            raise ValueError(f"callout kind must be one of {', '.join(CALLOUT_KINDS)}")
        text = str(item.get("text") or "").strip()
        if text:
            out.append({"kind": kind, "text": text})
    return out


def step_callouts(d: dict[str, Any]) -> list[dict[str, str]]:
    """Callouts of a snapshot step dict, reading legacy ``caution`` snapshots."""
    if d.get("callouts") is not None:
        return [dict(c) for c in d["callouts"]]
    if d.get("caution"):
        return [{"kind": "caution", "text": d["caution"]}]
    return []
