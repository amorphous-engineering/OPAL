"""Extension hook for the Onshape integration.

Declared by ``opal/extensions/bundled/opal.onshape/opal-ext.yaml`` and called
by ``opal.extensions.loader.activate`` at startup and after every event that
can change the integration's footing — a demo switch, a factory reset, an
operator toggling the extension on the settings page.

The only background work Onshape owns is its polling task, and
``start_onshape_polling`` already reconciles that task against current config
(it cancels any running task first, then starts one only if the integration is
enabled and configured). So the hook delegates in both directions: enabling
starts polling if credentials allow, disabling cancels it.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI

#: Manifest id of the bundled Onshape extension.
EXTENSION_ID = "opal.onshape"

logger = logging.getLogger("opal.extensions")


def is_enabled() -> bool:
    """True when the operator has the Onshape extension switched on.

    Opens its own short session: the callers that gate on this (polling start,
    the settings page, the sync endpoints) are not all holding one. Fails
    closed — if the registry cannot be read, the integration stays off rather
    than reaching out to Onshape on an instance in an unknown state.
    """
    from opal.db.base import SessionLocal
    from opal.extensions import registry

    try:
        with SessionLocal() as db:
            return registry.is_enabled(db, EXTENSION_ID)
    except Exception:
        logger.warning("Cannot read the Onshape extension state", exc_info=True)
        return False


def register(app: FastAPI, *, enabled: bool) -> None:
    """Bring Onshape's background work in line with the extension's state."""
    from opal.api.app import start_onshape_polling

    # start_onshape_polling re-reads the enabled flag itself, so it is correct
    # for both directions; `enabled` is accepted to satisfy the hook contract
    # and to keep the call site readable.
    start_onshape_polling(app)
