"""Extension manifest — the `opal-ext.yaml` schema and its validator.

An extension is a directory containing `opal-ext.yaml` plus the content that
manifest declares. Two origins exist and they are not equally trusted:

- ``bundled``   — ships inside the OPAL package, reviewed as part of the
                  release, and may declare a ``code:`` entry point.
- ``installed`` — unpacked from an operator-uploaded archive at runtime.
                  Declarative content only; a ``code:`` key is refused at
                  install time rather than ignored, so an extension author
                  learns immediately instead of shipping a silent no-op.

Everything here is pure validation — no filesystem writes, no database.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, field_validator

from opal import __version__

#: The manifest filename. Fixed — discovery is a directory scan for this name.
MANIFEST_FILENAME = "opal-ext.yaml"

#: Reverse-dns-ish identifier: lowercase, dot/hyphen separated.
_ID_RE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")

#: Permissive semver: major.minor[.patch][-pre][+build].
_VERSION_RE = re.compile(r"^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$")

#: Capability names an extension may declare under `provides:`. Each maps to a
#: loader in opal.extensions.content; adding a name here without a loader would
#: make the manifest accept content nothing ever reads.
CAPABILITIES: tuple[str, ...] = ("procedures", "datasets")


class ManifestError(ValueError):
    """The manifest is missing, unparseable, or invalid."""


class ExtensionProvides(BaseModel):
    """Declarative content an extension contributes.

    Values are glob patterns relative to the extension root. Patterns are
    resolved at read time, not at install time, so an extension directory
    edited in place stays truthful.
    """

    model_config = ConfigDict(extra="forbid")

    procedures: list[str] = Field(default_factory=list)
    datasets: list[str] = Field(default_factory=list)

    @field_validator("procedures", "datasets")
    @classmethod
    def _safe_relative_glob(cls, patterns: list[str]) -> list[str]:
        for pattern in patterns:
            if not pattern or pattern.startswith("/") or pattern.startswith("~"):
                raise ValueError(f"content pattern must be relative: {pattern!r}")
            if ".." in Path(pattern).parts:
                raise ValueError(f"content pattern must not escape the extension: {pattern!r}")
        return patterns

    def is_empty(self) -> bool:
        return not any(getattr(self, name) for name in CAPABILITIES)


class ExtensionCode(BaseModel):
    """A Python entry point. Bundled extensions only — see module docstring."""

    model_config = ConfigDict(extra="forbid")

    entry_point: str = Field(
        description="'package.module:callable', invoked once with the FastAPI app"
    )

    @field_validator("entry_point")
    @classmethod
    def _dotted_path_with_attr(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z_][\w.]*:[A-Za-z_]\w*", value):
            raise ValueError("entry_point must look like 'package.module:callable'")
        return value


class ExtensionManifest(BaseModel):
    """Parsed and validated `opal-ext.yaml`."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(max_length=64)
    name: str = Field(max_length=120)
    version: str = Field(max_length=32)
    opal: str = Field(default=">=1.4", max_length=64, description="PEP 440 compatibility specifier")
    summary: str | None = Field(default=None, max_length=200)
    author: str | None = Field(default=None, max_length=120)
    license: str | None = Field(default=None, max_length=64)
    homepage: str | None = Field(default=None, max_length=300)
    provides: ExtensionProvides = Field(default_factory=ExtensionProvides)
    code: ExtensionCode | None = None

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        if not _ID_RE.match(value):
            raise ValueError(
                "id must be lowercase alphanumerics separated by '.' or '-' (e.g. acme.qms-pack)"
            )
        return value

    @field_validator("version")
    @classmethod
    def _valid_version(cls, value: str) -> str:
        if not _VERSION_RE.match(value):
            raise ValueError("version must look like 1.0 or 1.0.0")
        return value

    @field_validator("opal")
    @classmethod
    def _valid_specifier(cls, value: str) -> str:
        try:
            SpecifierSet(value)
        except InvalidSpecifier as err:
            raise ValueError(f"opal must be a PEP 440 specifier (e.g. '>=1.4'): {err}") from err
        return value

    @field_validator("homepage")
    @classmethod
    def _http_homepage(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith(("http://", "https://")):
            raise ValueError("homepage must be an http(s) URL")
        return value

    def compatible_with(self, opal_version: str = __version__) -> bool:
        """True when this extension declares support for ``opal_version``.

        The comparison uses the *base* version, so 1.4.0b2 satisfies '>=1.4':
        a beta of 1.4 is the build an extension targeting 1.4 is written and
        tested against, and PEP 440 ordering — which puts 1.4.0b2 below 1.4 —
        would otherwise reject every extension on every prerelease.
        """
        try:
            release = Version(Version(opal_version).base_version)
        except InvalidVersion:
            return False
        return SpecifierSet(self.opal).contains(release, prereleases=True)


def parse_manifest(raw: str) -> ExtensionManifest:
    """Parse manifest YAML text. Raises :class:`ManifestError` on any problem."""
    try:
        data: Any = yaml.safe_load(raw)
    except yaml.YAMLError as err:
        raise ManifestError(f"{MANIFEST_FILENAME} is not valid YAML: {err}") from err

    if not isinstance(data, dict):
        raise ManifestError(f"{MANIFEST_FILENAME} must contain a YAML mapping")

    try:
        return ExtensionManifest.model_validate(data)
    except Exception as err:
        raise ManifestError(f"{MANIFEST_FILENAME} is invalid: {_first_error(err)}") from err


def load_manifest(root: Path) -> ExtensionManifest:
    """Read and validate the manifest in the extension directory ``root``."""
    path = root / MANIFEST_FILENAME
    if not path.is_file():
        raise ManifestError(f"no {MANIFEST_FILENAME} in {root.name}")
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise ManifestError(f"cannot read {MANIFEST_FILENAME}: {err}") from err
    return parse_manifest(raw)


def _first_error(err: Exception) -> str:
    """Reduce a pydantic ValidationError to one operator-readable line."""
    errors = getattr(err, "errors", None)
    if not callable(errors):
        return str(err)
    try:
        first = errors()[0]
    except (IndexError, TypeError):
        return str(err)
    location = ".".join(str(part) for part in first.get("loc", ())) or "manifest"
    return f"{location}: {first.get('msg', 'invalid')}"
