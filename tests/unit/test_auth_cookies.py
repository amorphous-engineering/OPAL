"""Tests for signed auth cookies (opal.core.auth)."""

from opal.core.auth import sign_user_id, verify_user_id


def test_sign_verify_roundtrip() -> None:
    value = sign_user_id(42)
    assert verify_user_id(value) == 42


def test_tampered_cookie_rejected() -> None:
    value = sign_user_id(42)
    payload, signature = value.rsplit(".", 1)
    assert verify_user_id(f"7.{signature}") is None
    assert verify_user_id(f"{payload}.{'0' * len(signature)}") is None


def test_legacy_bare_id_rejected() -> None:
    # Pre-signing cookies were the bare user id; they must not authenticate
    assert verify_user_id("5") is None
    assert verify_user_id("") is None
    assert verify_user_id(None) is None
