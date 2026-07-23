"""Jinja2 template response compatibility shim.

Starlette 1.0 removed the old ``TemplateResponse(name, context)`` signature in
favour of ``TemplateResponse(request, name, context)``. OPAL has ~137 call
sites using the old form; translating them here keeps the upgrade to Starlette
1.x (which fixes PYSEC-2026-161 / -249) from requiring a churny mechanical
rewrite of every web route. Call sites may be migrated to the new signature
incrementally; until then this subclass accepts both.
"""

from typing import Any

from starlette.templating import Jinja2Templates as _Jinja2Templates


class Jinja2Templates(_Jinja2Templates):
    """``Jinja2Templates`` that also accepts the pre-Starlette-1.0 call form."""

    def TemplateResponse(self, *args: Any, **kwargs: Any) -> Any:
        # New form — first positional arg is the Request — passes straight
        # through. Old form — first positional arg is the template name.
        if args and isinstance(args[0], str):
            name = args[0]
            context = args[1] if len(args) > 1 else kwargs.pop("context", None)
            context = dict(context or {})
            request = context.get("request") or kwargs.pop("request", None)
            extra = args[2:]  # status_code/headers/... if passed positionally
            return super().TemplateResponse(request, name, context, *extra, **kwargs)
        return super().TemplateResponse(*args, **kwargs)
