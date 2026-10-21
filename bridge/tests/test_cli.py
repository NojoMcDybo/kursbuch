"""CLI-Brücke für die App: status, config, login, index."""
import io
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from helpers import make_pdf, make_state, put
from test_client import FakeLearnWeb

from learnweb import cli, credentials, sync


def run(capsys, *argv):
    code = cli.main(list(argv))
    out = capsys.readouterr().out
    return code, json.loads(out.strip().splitlines()[-1]), out


def test_status_on_empty_installation(capsys):
    code, s, _ = run(capsys, "status")
    assert code == 0
    assert (s["last_run"], s["running"], s["lock"], s["courses"], s["deadlines"]) == (None, False, None, 0, None)
    assert s["index"] == {"exists": False} and s["login"] == {"saved": False, "user": None}
    assert s["config"] == sync.DEFAULT_CONFIG


def test_status_with_data_login_and_running_lock(tmp_path, capsys):
    sync.save_json(sync.STATE, make_state([(1, "forum", "F", [])]))
    sync.save_json(sync.DEADLINES, {"updated": 5, "items": [{"ts": 1}, {"ts": 2}]})
    credentials.save("abc", "pw")
    sync.LOCK.write_text(str(os.getpid()))
    _, s, out = run(capsys, "status")
    assert (s["last_run"], s["courses"], s["running"]) == (1, 1, True)
    assert s["deadlines"] == {"updated": 5, "count": 2} and s["lock"]["pid"] == os.getpid()
    assert s["login"] == {"saved": True, "user": "abc"} and '"pw"' not in out  # das Passwort wird nie ausgegeben


def test_config_set_validates_and_writes(capsys):
    assert run(capsys, "config", "set", "kurse_aus", "[3, 1, 3]")[1] == {"ok": True, "key": "kurse_aus", "value": [1, 3]}
    assert run(capsys, "config", "set", "kurse_extra", "5, 6")[1]["value"] == [5, 6]
    assert run(capsys, "config", "set", "max_mb", "50")[1]["value"] == 50
    assert run(capsys, "config", "set", "pause_s", "0.5")[1]["value"] == 0.5
    assert run(capsys, "config", "set", "kurse_ab", "2026-09-01")[1]["ok"]
    code, got, _ = run(capsys, "config", "get")
    assert code == 0 and got["config"]["kurse_aus"] == [1, 3] and got["config"]["max_mb"] == 50
    assert json.loads(sync.CONFIG.read_text(encoding="utf-8"))["kurse_ab"] == "2026-09-01"
    assert run(capsys, "config", "get", "max_mb")[1] == {"ok": True, "config": {"max_mb": 50}}


@pytest.mark.parametrize("key, value", [("pause_s", "0.05"), ("pause_s", "abc"), ("max_mb", "0"), ("max_mb", "9999"),
                                        ("kurse_ab", "31.12.2026"), ("ziel", "relativ\\pfad"), ("kurse_aus", "[1, \"x\"]"),
                                        ("unbekannt", "1")])
def test_config_set_rejects_bad_values_and_leaves_file_alone(capsys, key, value):
    sync.save_json(sync.CONFIG, sync.DEFAULT_CONFIG)
    before = sync.CONFIG.read_bytes()
    code, res, _ = run(capsys, "config", "set", key, value)
    assert code == 1 and res["ok"] is False and sync.CONFIG.read_bytes() == before


def test_config_get_unknown_key_and_missing_value(capsys):
    assert run(capsys, "config", "get", "nope")[0] == 1
    with pytest.raises(SystemExit):
        cli.main(["config", "set", "max_mb"])


def test_events_command_builds_from_the_state_without_network(capsys):
    assert run(capsys, "events")[0] == 1  # noch kein State
    state = make_state([(1, "label", "The deadline is 1 December 2026, 12 noon.", [])], name="Kurs WiSe 2026/27")
    state["courses"]["7"]["layout"] = [["12 October: Introduction", ["1"]]]
    sync.save_json(sync.STATE, state)
    code, res, _ = run(capsys, "events")
    assert code == 0 and res == {"ok": True, "count": 2, "kinds": {"sitzung": 1, "frist": 1}}
    assert [e["kind"] for e in json.loads(sync.EVENTS.read_text(encoding="utf-8"))["items"]] == ["sitzung", "frist"]


def test_suggest_command_needs_a_state_and_writes_the_file_even_without_an_index(capsys):
    assert run(capsys, "suggest")[0] == 1  # noch kein State
    sync.save_json(sync.STATE, make_state([(1, "label", "Text", [])], name="Kurs WiSe 2026/27"))
    code, res, _ = run(capsys, "suggest")  # kein Suchindex: keine Vorschlaege, kein Fehler
    assert (code, res) == (0, {"ok": True, "count": 0})
    assert json.loads(sync.SUGGESTIONS.read_text(encoding="utf-8"))["items"] == []


# --------------------------------------------------------------------------- login

def stdin(monkeypatch, text):
    monkeypatch.setattr(sys, "stdin", io.StringIO(text))


def test_login_saves_only_after_a_successful_check(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_TRANSPORT", httpx.MockTransport(FakeLearnWeb(password="richtig")))
    stdin(monkeypatch, "richtig\n")
    code, res, out = run(capsys, "login", "abc")
    assert code == 0 and res == {"ok": True, "user": "abc"}
    assert credentials.stored() == "abc" and credentials.password("abc") == "richtig"
    assert "richtig" not in out


def test_wrong_password_reports_and_keeps_the_old_login(monkeypatch, capsys):
    credentials.save("abc", "alt-aber-gut")
    monkeypatch.setattr(cli, "_TRANSPORT", httpx.MockTransport(FakeLearnWeb(password="richtig")))
    stdin(monkeypatch, "falsch\n")
    code, res, out = run(capsys, "login", "abc")
    assert code == 1 and res == {"ok": False, "error": "Ungültige Anmeldedaten"}
    assert credentials.password("abc") == "alt-aber-gut" and "falsch" not in out


def test_login_without_password_or_network(monkeypatch, capsys):
    stdin(monkeypatch, "\n")
    assert run(capsys, "login", "abc")[1]["ok"] is False

    def offline(request):
        raise httpx.ConnectError("weg")

    monkeypatch.setattr(cli, "_TRANSPORT", httpx.MockTransport(offline))
    stdin(monkeypatch, "irgendwas\n")
    code, res, out = run(capsys, "login", "abc")
    assert code == 1 and "nicht erreichbar" in res["error"] and "irgendwas" not in out
    assert credentials.stored() is None


def test_login_without_saving_checks_but_stores_nothing(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_TRANSPORT", httpx.MockTransport(FakeLearnWeb(password="richtig")))
    stdin(monkeypatch, "richtig\n")
    code, res, out = run(capsys, "login", "abc", "--no-save")
    assert code == 0 and res == {"ok": True, "user": "abc"}
    assert credentials.stored() is None and credentials.keyring.store == {} and "richtig" not in out
    stdin(monkeypatch, "falsch\n")
    assert run(capsys, "login", "abc", "--no-save")[0] == 1  # geprueft wird auch ohne Speichern


def test_no_save_login_leaves_an_existing_stored_login_alone(monkeypatch, capsys):
    credentials.save("abc", "alt-aber-gut")  # geplanter Sync und MCP-Server brauchen es weiter
    monkeypatch.setattr(cli, "_TRANSPORT", httpx.MockTransport(FakeLearnWeb(password="richtig")))
    stdin(monkeypatch, "richtig\n")
    run(capsys, "login", "abc", "--no-save")
    assert credentials.keyring.get_password(credentials.SERVICE, "abc") == "alt-aber-gut"


def test_session_password_from_stdin_replaces_the_vault_for_one_run(monkeypatch, capsys):
    monkeypatch.setattr(credentials, "_SESSION_PW", None)  # stellt es nach dem Test zurueck
    stdin(monkeypatch, "nur-sitzung\n")
    run(capsys, "--password-stdin", "status")
    assert credentials.password("abc") == "nur-sitzung" and credentials.stored() is None  # im Tresor liegt nichts


def test_logout_removes_the_stored_login_and_is_harmless_without_one(capsys):
    credentials.save("abc", "geheim")
    code, res, out = run(capsys, "logout")
    assert (code, res) == (0, {"ok": True}) and credentials.stored() is None and "geheim" not in out
    assert run(capsys, "logout")[1] == {"ok": True}  # zweimal ist egal


# --------------------------------------------------------------------------- index

def test_index_command_builds_and_rebuilds(tmp_path, capsys):
    ziel = tmp_path / "vault"
    put(ziel, "Kurs/a.pdf", make_pdf(["Taktik", "Technik"]))
    sync.save_json(sync.STATE, make_state([(1, "resource", "A", ["Kurs/a.pdf"])]))
    sync.save_json(sync.CONFIG, {**sync.DEFAULT_CONFIG, "ziel": str(ziel)})
    code, res, _ = run(capsys, "index")
    assert code == 0 and res["ok"] and res["indexed"] == 1 and not sync.LOCK.exists()
    assert run(capsys, "index")[1]["unchanged"] == 1
    assert run(capsys, "index", "--rebuild")[1]["indexed"] == 1
    assert run(capsys, "status")[1]["index"]["files"] == 1


def test_index_command_needs_state_and_respects_the_lock(tmp_path, capsys):
    assert run(capsys, "index")[0] == 1
    sync.save_json(sync.STATE, make_state([]))
    sync.LOCK.write_text(str(os.getpid()))
    code, res, _ = run(capsys, "index")
    assert code == 2 and res["code"] == "locked" and sync.LOCK.exists()


def test_config_accepts_auto_for_the_course_start(capsys):
    assert run(capsys, "config", "set", "kurse_ab", "AUTO")[1] == {"ok": True, "key": "kurse_ab", "value": "auto"}
    assert run(capsys, "config", "set", "kurse_ab", "2026-03-01")[1]["value"] == "2026-03-01"
    assert run(capsys, "config", "set", "kurse_ab", "morgen")[1]["ok"] is False


# --------------------------------------------------------------------------- mitgelieferte Bruecke (Kursbuch zum Weitergeben)

def test_selftest_reports_every_check_without_network(capsys):
    code, res, _ = run(capsys, "selftest")
    assert code == 0 and res["ok"] is True
    assert set(res["checks"]) == {"tresor", "zertifikate", "suche", "leser", "datenordner"}
    assert res["checks"]["zertifikate"]["info"] > 50 and res["frozen"] is False


def test_data_and_config_live_where_learnweb_home_says(tmp_path):
    import subprocess
    root = Path(__file__).resolve().parents[1]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "LEARNWEB_HOME": str(tmp_path / "Jörg Müller" / "brücke")}
    code = "import learnweb.sync as s; print(s.ROOT); print(s.CONFIG); print(s.STATE); print(s.DEFAULT_CONFIG['ziel'])"
    out = subprocess.run([sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", check=True).stdout.splitlines()
    home = tmp_path / "Jörg Müller" / "brücke"
    assert [Path(x) for x in out[:3]] == [home, home / "sync_config.json", home / "data" / "sync_state.json"]
    # neutraler Vorgabeordner (kein fremder Tresor), im Ordner „Dokumente“
    assert Path(out[3]).parts[-2:] == ("Kursbuch", "LearnWeb") and "Second Brain" not in out[3]


def test_default_target_folder_is_neutral():
    from learnweb import sync as s
    assert Path(s.DEFAULT_CONFIG["ziel"]).name == "LearnWeb" and "Second Brain" not in s.DEFAULT_CONFIG["ziel"]


def test_selftest_net_reads_only_the_public_login_page(capsys):
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path, request.content))
        return httpx.Response(200, text='<form id="login"><input type="hidden" name="logintoken" value="T0K"></form>')

    cli._TRANSPORT = httpx.MockTransport(handler)
    try:
        code, res, _ = run(capsys, "selftest", "--net")
    finally:
        cli._TRANSPORT = None
    assert code == 0 and res["checks"]["netz"] == {"ok": True, "info": "Anmeldeseite erreichbar"}
    assert seen == [("GET", "/LearnWeb/learnweb2/login/index.php", b"")]  # eine Anfrage, kein POST, keine Zugangsdaten

    def offline(request):
        raise httpx.ConnectError("weg")

    cli._TRANSPORT = httpx.MockTransport(offline)
    try:
        code, res, _ = run(capsys, "selftest", "--net")
    finally:
        cli._TRANSPORT = None
    assert code == 1 and res["checks"]["netz"]["ok"] is False and res["checks"]["tresor"]["ok"] is True
