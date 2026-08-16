"""Local CUPS printer discovery and job dispatch.

OPAL runs on one machine (see CLAUDE.md); direct-print means printing to
whatever's attached to that machine, so this shells out to the system's
own `lpstat`/`lp` rather than speaking a print protocol directly.
"""

import subprocess
import tempfile
from pathlib import Path


class PrinterError(Exception):
    """Raised when listing printers or dispatching a print job fails."""


def list_printers() -> list[dict[str, str]]:
    """List CUPS printers known to this machine, with their status."""
    try:
        result = subprocess.run(
            ["lpstat", "-p"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrinterError(f"Could not query printers: {exc}") from exc

    printers = []
    for line in result.stdout.splitlines():
        if not line.startswith("printer "):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        if " is idle" in line:
            status = "idle"
        elif " is printing" in line or " now printing" in line:
            status = "printing"
        elif " disabled " in line:
            status = "disabled"
        else:
            status = "unknown"
        printers.append({"name": parts[1], "status": status})
    return printers


def print_file(printer: str, pdf_bytes: bytes) -> None:
    """Send a PDF to a named CUPS printer.

    Validates the printer name against the live `lpstat -p` list rather
    than trusting the caller — the name ends up as a CLI argument to
    `lp`, so this also guards against an unexpected/mistyped target.
    """
    known = {p["name"] for p in list_printers()}
    if printer not in known:
        raise PrinterError(f"Unknown printer: {printer}")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = Path(f.name)
    try:
        result = subprocess.run(
            ["lp", "-d", printer, str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise PrinterError(result.stderr.strip() or "lp failed")
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrinterError(f"Could not send print job: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)
