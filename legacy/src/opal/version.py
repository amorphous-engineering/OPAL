"""Build identification — enriches the release version with git state.

``opal.__version__`` stays the plain PEP 440 release version (it feeds the
updater's version comparison and release stamping). This module answers the
question "which build is this instance actually running?":

- Frozen release binary:      ``1.3.2``
- Source checkout:            ``1.3.2+devel.6befb6f`` (branch, short SHA)
- ... with uncommitted edits: ``1.3.2+devel.6befb6f.dirty``
- Installed wheel (no git):   ``1.3.2``

The ``+local`` segment is PEP 440-compliant and ignored by version ordering,
so dev builds still see the next release as an update.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from opal import __version__


@dataclass(frozen=True)
class VersionInfo:
    """Identity of the running build."""

    base: str
    branch: str | None = None
    commit: str | None = None
    dirty: bool = False

    @property
    def is_dev(self) -> bool:
        """True when running from a git checkout rather than a release build."""
        return self.commit is not None

    @property
    def full(self) -> str:
        """PEP 440 version string, e.g. ``1.3.2+devel.6befb6f.dirty``."""
        if not self.is_dev:
            return self.base
        parts = []
        if self.branch:
            parts.append(_sanitize_local_segment(self.branch))
        parts.append(self.commit or "")
        if self.dirty:
            parts.append("dirty")
        return f"{self.base}+{'.'.join(parts)}"

    @property
    def display(self) -> str:
        """Version string for UI display, e.g. ``v1.3.2+devel.6befb6f``."""
        return f"v{self.full}"

    @property
    def tooltip(self) -> str:
        """Human-readable build description for hover text."""
        if not self.is_dev:
            return f"Release v{self.base}"
        branch = self.branch or "detached HEAD"
        suffix = ", uncommitted changes" if self.dirty else ""
        return f"DEV BUILD — {branch} @ {self.commit}{suffix}"


def _sanitize_local_segment(text: str) -> str:
    """Reduce arbitrary text (branch names) to a valid PEP 440 local segment."""
    return re.sub(r"[^a-zA-Z0-9.]+", ".", text).strip(".")


def _git(args: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


@lru_cache(maxsize=1)
def get_version_info() -> VersionInfo:
    """Identify the running build. Cached for the process lifetime."""
    if getattr(sys, "frozen", False):
        # PyInstaller release binary — version was stamped from the git tag.
        return VersionInfo(base=__version__)

    pkg_dir = Path(__file__).resolve().parent
    commit = _git(["rev-parse", "--short", "HEAD"], pkg_dir)
    if not commit:
        # Installed wheel/tarball, or git unavailable.
        return VersionInfo(base=__version__)

    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], pkg_dir)
    if branch == "HEAD":
        branch = None
    status = _git(["status", "--porcelain", "--untracked-files=no"], pkg_dir)
    return VersionInfo(
        base=__version__,
        branch=branch,
        commit=commit,
        dirty=bool(status),
    )
