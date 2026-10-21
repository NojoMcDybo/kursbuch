"""Zugangsdaten in der Windows-Anmeldeinformationsverwaltung (über keyring).

Nichts landet in Dateien, .env oder der Shell-History.
"""
from __future__ import annotations

import os

import keyring

SERVICE = "learnweb-mcp"
_USER_KEY = "__username__"


_SESSION_PW: str | None = None  # nur im Speicher dieses Prozesses (Kursbuch: „Passwort nicht speichern“), nie auf der Platte


def session_password(pw: str) -> None:
    """Passwort nur für diesen Lauf verwenden (die App reicht es per stdin durch, ohne es im Tresor abzulegen)."""
    global _SESSION_PW
    _SESSION_PW = pw or None


class NoCredentials(RuntimeError):
    """Keine (vollständigen) Zugangsdaten gespeichert – die CLI meldet das als eigenen Fehlercode."""


def save(username: str, password: str) -> None:
    keyring.set_password(SERVICE, _USER_KEY, username)
    keyring.set_password(SERVICE, username, password)


def username() -> str:
    u = os.environ.get("LEARNWEB_USER") or keyring.get_password(SERVICE, _USER_KEY)
    if not u:
        raise NoCredentials("Keine LearnWeb-Zugangsdaten gespeichert. Erst `uv run python setup_login.py` ausführen.")
    return u


def password(user: str) -> str:
    if _SESSION_PW:
        return _SESSION_PW
    p = keyring.get_password(SERVICE, user)
    if not p:
        raise NoCredentials("Kein Passwort gespeichert. Erst `uv run python setup_login.py` ausführen.")
    return p


def stored() -> str | None:
    """Die Kennung, falls Kennung und Passwort gespeichert sind (das Passwort wird nicht herausgegeben)."""
    try:
        u = username()
    except NoCredentials:
        return None
    return u if keyring.get_password(SERVICE, u) else None


def delete() -> None:
    u = keyring.get_password(SERVICE, _USER_KEY)
    for key in filter(None, [u, _USER_KEY]):
        try:
            keyring.delete_password(SERVICE, key)
        except keyring.errors.PasswordDeleteError:
            pass
