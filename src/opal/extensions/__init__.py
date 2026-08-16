"""OPAL extensions — packaged units of functionality outside the core.

An extension is a directory with an ``opal-ext.yaml`` manifest. Two origins:

``bundled``
    Ships inside the OPAL package under ``extensions/bundled/``. Reviewed as
    part of the release, so it may declare a ``code:`` entry point. The
    Onshape integration is one. Bundled extensions can be disabled but never
    uninstalled — the files belong to the install, not the instance.

``installed``
    Unpacked from an operator-uploaded ZIP into ``<data_dir>/extensions/``.
    Declarative content only: procedure and dataset templates the operator
    imports explicitly. A ``code:`` key is refused at install time.

The split is the whole security posture: uploading an archive must never be a
way to run code. Code hooks for third-party extensions are deliberately future
work, gated on a design for consent and isolation that does not exist yet.

See ``docs`` in OPAL_manual.md ("Extensions") for the authoring guide.
"""

from opal.extensions.manifest import (
    CAPABILITIES,
    MANIFEST_FILENAME,
    ExtensionManifest,
    ManifestError,
    load_manifest,
    parse_manifest,
)
from opal.extensions.registry import (
    BrokenExtension,
    DiscoveredExtension,
    discover,
    find,
    get_row,
    is_enabled,
    set_enabled,
    sync,
)

__all__ = [
    "CAPABILITIES",
    "MANIFEST_FILENAME",
    "BrokenExtension",
    "DiscoveredExtension",
    "ExtensionManifest",
    "ManifestError",
    "discover",
    "find",
    "get_row",
    "is_enabled",
    "load_manifest",
    "parse_manifest",
    "set_enabled",
    "sync",
]
