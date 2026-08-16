"""Tests for CUPS printer discovery and dispatch (core/printing.py)."""

import subprocess
from unittest.mock import MagicMock

import pytest

from opal.core import printing


def _fake_run(stdout: str = "", returncode: int = 0, stderr: str = ""):
    def _run(*args, **kwargs):
        result = MagicMock()
        result.stdout = stdout
        result.stderr = stderr
        result.returncode = returncode
        return result

    return _run


def test_list_printers_parses_idle_and_disabled(monkeypatch):
    stdout = (
        "printer DYMO_LabelManager_280 is idle.  enabled since Sat Aug 15 00:34:47 2026\n"
        "printer Office_Laser disabled since Sat Aug 15 19:55:56 2026 -\n"
        "\tUnable to send data to printer.\n"
    )
    monkeypatch.setattr(subprocess, "run", _fake_run(stdout=stdout))
    printers = printing.list_printers()
    assert {"name": "DYMO_LabelManager_280", "status": "idle"} in printers
    assert {"name": "Office_Laser", "status": "disabled"} in printers


def test_list_printers_empty_when_none_configured(monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run(stdout=""))
    assert printing.list_printers() == []


def test_list_printers_raises_on_missing_lpstat(monkeypatch):
    def _raise(*args, **kwargs):
        raise OSError("no such command")

    monkeypatch.setattr(subprocess, "run", _raise)
    with pytest.raises(printing.PrinterError):
        printing.list_printers()


def test_print_file_rejects_unknown_printer(monkeypatch):
    monkeypatch.setattr(printing, "list_printers", lambda: [{"name": "Known", "status": "idle"}])
    with pytest.raises(printing.PrinterError, match="Unknown printer"):
        printing.print_file("NotConfigured", b"%PDF-1.4 fake")


def test_print_file_dispatches_known_printer(monkeypatch):
    monkeypatch.setattr(printing, "list_printers", lambda: [{"name": "Known", "status": "idle"}])
    calls = []

    def _run(args, **kwargs):
        calls.append(args)
        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        return result

    monkeypatch.setattr(subprocess, "run", _run)
    printing.print_file("Known", b"%PDF-1.4 fake")
    assert calls[0][:3] == ["lp", "-d", "Known"]


def test_print_file_raises_on_lp_failure(monkeypatch):
    monkeypatch.setattr(printing, "list_printers", lambda: [{"name": "Known", "status": "idle"}])
    monkeypatch.setattr(
        subprocess, "run", _fake_run(returncode=1, stderr="printer-stopped")
    )
    with pytest.raises(printing.PrinterError, match="printer-stopped"):
        printing.print_file("Known", b"%PDF-1.4 fake")
