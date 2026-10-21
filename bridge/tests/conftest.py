"""Gemeinsame Testumgebung: alle Pfade und Zugangsdaten zeigen in den Temp-Ordner.
Kein Test darf echte Daten (State, Konfiguration, Vault) oder die Windows-Anmeldeinformationsverwaltung anfassen."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from learnweb import cli, credentials, sync  # noqa: E402


class FakeKeyring:
    errors = credentials.keyring.errors

    def __init__(self):
        self.store = {}

    def get_password(self, service, key):
        return self.store.get((service, key))

    def set_password(self, service, key, value):
        self.store[(service, key)] = value

    def delete_password(self, service, key):
        if (service, key) not in self.store:
            raise self.errors.PasswordDeleteError("nicht vorhanden")
        del self.store[(service, key)]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    data = tmp_path / "data"
    monkeypatch.setattr(sync, "CONFIG", tmp_path / "sync_config.json")
    monkeypatch.setattr(sync, "STATE", data / "sync_state.json")
    monkeypatch.setattr(sync, "LOCK", data / "sync.lock")
    monkeypatch.setattr(sync, "DEADLINES", data / "deadlines.json")
    monkeypatch.setattr(sync, "EVENTS", data / "events.json")
    monkeypatch.setattr(sync, "CONTENT", data / "content.json")
    monkeypatch.setattr(sync, "SCHEDULE", data / "schedule.json")
    monkeypatch.setattr(sync, "SUGGESTIONS", data / "suggestions.json")
    monkeypatch.setattr(sync, "INDEX", data / "index.db")
    monkeypatch.setattr(sync, "JSON_MODE", False)  # sync.main() setzt es global, monkeypatch stellt es zurück
    monkeypatch.setattr(cli, "_TRANSPORT", None)
    monkeypatch.delenv("LEARNWEB_USER", raising=False)
    monkeypatch.setattr(credentials, "keyring", FakeKeyring())


@pytest.fixture
def db(tmp_path):
    return tmp_path / "idx.db"
