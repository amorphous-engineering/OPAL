"""Activation of bundled code extensions.

Only extensions that ship inside the package reach this module — the installer
refuses a ``code:`` key on an uploaded archive — so activation runs code that
was already part of the release, never operator-supplied Python.

The hook is called for enabled *and* disabled extensions, with the state
passed in, so an extension can tear its background work down as well as start
it. Activation is therefore a reconciliation, not a one-shot init: it runs at
startup and again after anything that changes the world underneath it (a demo
switch, a factory reset, an operator toggling the extension).

Hook contract::

    def register(app: FastAPI, *, enabled: bool) -> None

Failures are logged and skipped. A broken extension must not stop the server.
"""

from __future__ import annotations

import importlib
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger("opal.extensions")


def activate(app: FastAPI) -> list[str]:
    """Reconcile every bundled code extension with its enabled state.

    Returns the ids that activated cleanly (enabled ones only). Never raises.
    """
    from opal.db.base import SessionLocal
    from opal.extensions import registry

    hooks: list[tuple[str, str, bool]] = []
    try:
        with SessionLocal() as db:
            registry.sync(db)
            db.commit()
            for ext in registry.discover()[0]:
                if not ext.is_bundled or ext.manifest.code is None:
                    continue
                hooks.append(
                    (ext.id, ext.manifest.code.entry_point, registry.is_enabled(db, ext.id))
                )
    except Exception:
        logger.warning("Extension registry unavailable — no extensions activated", exc_info=True)
        return []

    activated: list[str] = []
    for ext_id, entry_point, enabled in hooks:
        try:
            _call_hook(entry_point, app, enabled=enabled)
        except Exception:
            logger.warning("Extension %s failed to activate", ext_id, exc_info=True)
            continue
        if enabled:
            activated.append(ext_id)
    return activated


def _call_hook(entry_point: str, app: FastAPI, *, enabled: bool) -> None:
    module_name, _, attribute = entry_point.partition(":")
    module = importlib.import_module(module_name)
    hook = getattr(module, attribute)
    hook(app, enabled=enabled)
