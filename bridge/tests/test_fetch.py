"""Sofort-Download einer Aktivitaet: gegen ein simuliertes LearnWeb im Temp-Ordner."""
import json
import os

import httpx
import pytest
from helpers import make_pdf, make_state, put

from learnweb import cli, credentials, fetch, index, sync
from learnweb.client import FileTooLarge, LoginError


class FakeLW:
    def __init__(self, fail=None, too_large=False):
        self.calls, self.fail, self.too_large, self.last_skipped = [], fail, too_large, []

    def download(self, cmid, typ, dest, max_bytes=None):
        self.calls.append((cmid, typ, dest, max_bytes))
        if self.fail:
            raise self.fail
        if self.too_large and max_bytes:
            raise FileTooLarge("u", 34_000_000)
        dest.mkdir(parents=True, exist_ok=True)
        if typ == "folder":
            paths = [dest / "a.pdf", dest / "b.pdf"]
            self.last_skipped = [FileTooLarge("u", 50_000_000)] if max_bytes else []
        else:
            paths = [dest / f"{cmid}.pdf"]
        for i, p in enumerate(paths):
            p.write_bytes(make_pdf([f"Gruppendynamik Datei {p.name} {i}"]))
        return paths


def prepare(tmp_path, monkeypatch, lw=None):
    ziel = tmp_path / "vault"
    sync.save_json(sync.CONFIG, {**sync.DEFAULT_CONFIG, "ziel": str(ziel), "max_mb": 20})
    state = make_state([(100, "resource", "Riesige Folien", []), (101, "folder", "Ordner Material", []), (102, "forum", "Forum", [])],
                       course_id=7, name="Kurs A WiSe 2026/27", dir_="Kurs A")
    for cm in state["courses"]["7"]["cms"].values():
        cm["section"] = "01 Woche 1"
    state["courses"]["7"]["cms"]["100"]["skipped"] = [{"mb": 34.0}]
    state["courses"]["7"]["cms"]["100"]["error"] = "frueher fehlgeschlagen"
    sync.save_json(sync.STATE, state)
    fake = lw or FakeLW()
    monkeypatch.setattr(sync, "LearnWeb", lambda creds: fake)
    monkeypatch.setattr(credentials, "username", lambda: "u")
    monkeypatch.setattr(credentials, "password", lambda u: "pw")
    return ziel, fake


def saved():
    return json.loads(sync.STATE.read_text(encoding="utf-8"))["courses"]["7"]


def test_fetch_a_file_puts_it_where_the_sync_would_and_updates_everything(tmp_path, monkeypatch):
    ziel, fake = prepare(tmp_path, monkeypatch)
    code, res = fetch.fetch(7, 100)
    assert code == 0 and res == {"ok": True, "files": ["Kurs A/01 Woche 1/100.pdf"], "skipped": []}
    assert (ziel / "Kurs A" / "01 Woche 1" / "100.pdf").is_file()
    assert fake.calls[0][3] == 20_000_000  # ohne --all-sizes gilt die Grenze des Syncs
    cm = saved()["cms"]["100"]
    assert cm["files"] == ["Kurs A/01 Woche 1/100.pdf"] and cm["skipped"] == [] and "error" not in cm
    assert "100.pdf" in (ziel / "Kurs A" / "Kurs A.md").read_text(encoding="utf-8")  # Kursnotiz verweist auf die Datei
    assert index.search(sync.INDEX, "gruppendynamik")[0]["cmid"] == 100  # im Suchindex
    assert "100.pdf" in (ziel / "verzeichnis.json").read_text(encoding="utf-8")  # im Verzeichnis
    assert not sync.LOCK.exists()


def test_all_sizes_removes_the_limit_and_clears_the_skipped_note(tmp_path, monkeypatch):
    _, fake = prepare(tmp_path, monkeypatch, FakeLW(too_large=True))
    code, res = fetch.fetch(7, 100)
    assert code == 1 and res["code"] == "too_large" and "34 MB" in res["error"] and "20 MB" in res["error"]
    assert saved()["cms"]["100"]["skipped"] == [{"mb": 34.0}]  # unveraendert
    code, res = fetch.fetch(7, 100, all_sizes=True)
    assert code == 0 and fake.calls[-1][3] is None and saved()["cms"]["100"]["skipped"] == []


def test_folder_files_and_skipped_ones(tmp_path, monkeypatch):
    prepare(tmp_path, monkeypatch)
    code, res = fetch.fetch(7, 101)
    assert code == 0 and len(res["files"]) == 2 and res["skipped"] == [{"mb": 50.0}]
    assert res["files"][0].startswith("Kurs A/01 Woche 1/Ordner Material/")


@pytest.mark.parametrize("course, cmid, text", [(7, 102, "Nur Dateien"), (7, 999, "nicht gefunden"), (999, 100, "nicht gefunden")])
def test_things_that_cannot_be_fetched(tmp_path, monkeypatch, course, cmid, text):
    prepare(tmp_path, monkeypatch)
    code, res = fetch.fetch(course, cmid)
    assert code == 1 and text in res["error"] and not sync.LOCK.exists()


def test_without_state_and_while_a_sync_runs(tmp_path, monkeypatch):
    assert fetch.fetch(7, 100)[0] == 1  # noch kein State
    ziel, fake = prepare(tmp_path, monkeypatch)
    sync.LOCK.write_text(str(os.getpid()))
    code, res = fetch.fetch(7, 100)
    assert code == 2 and res["code"] == "locked" and fake.calls == [] and sync.LOCK.exists()


@pytest.mark.parametrize("exc, code", [(LoginError("Ungültige Anmeldedaten"), "login"), (httpx.ConnectError("weg"), "network"),
                                       (credentials.NoCredentials("keine"), "credentials")])
def test_failures_are_reported_with_a_code_and_release_the_lock(tmp_path, monkeypatch, exc, code):
    prepare(tmp_path, monkeypatch, FakeLW(fail=exc))
    if code == "credentials":
        monkeypatch.setattr(credentials, "username", lambda: (_ for _ in ()).throw(exc))
    c, res = fetch.fetch(7, 100)
    assert c == 1 and res["code"] == code and not sync.LOCK.exists()
    assert saved()["cms"]["100"]["files"] == []  # der State bleibt, wie er war


def test_cli_command(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, monkeypatch)
    assert cli.main(["fetch", "7", "100", "--all-sizes"]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["ok"] is True
