"""Sync: neue State-Felder, --json, Sperre, Fristen und Index – gegen ein simuliertes LearnWeb im Temp-Ordner."""
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

import httpx
import pytest
from helpers import make_pdf

from learnweb import credentials, index, sync
from learnweb.client import LoginError

CFG = {**sync.DEFAULT_CONFIG, "pause_s": 0, "kurse_ab": "2020-01-01"}
COURSE = {"id": 7, "fullname": "Kurs A", "viewurl": "https://x/course/view.php?id=7"}
FOLIEN = {"id": "100", "name": "Folien", "module": "resource", "url": "u100", "uservisible": True}
NEU = {"id": "101", "name": "Neue Folien", "module": "resource", "url": "u101", "uservisible": True}
DEADLINE = {"ts": 1_800_000_000, "faellig": "2027-01-15 12:00", "ueberfaellig": False, "titel": "Abgabe", "typ": "assign",
            "was": "Abgabe", "kurs": "Kurs A", "kurs_id": 7, "url": "https://x/a"}


class FakeLW:
    def __init__(self, cms=(FOLIEN,), changed=()):
        self.cms, self.changed, self.last_skipped = list(cms), set(changed), []

    def ajax(self, method, args):
        if method == "core_courseformat_get_state":
            return json.dumps({"course": {"sectionlist": ["10"]}, "cm": self.cms,
                               "section": [{"id": "10", "title": "Woche 1", "number": 1, "hassummary": False,
                                            "cmlist": [c["id"] for c in self.cms]}]})
        if method == "core_course_get_updates_since":
            return {"instances": [{"contextlevel": "module", "id": int(i), "updates": [{"name": "contentfiles"}]}
                                  for i in self.changed]}
        if method == "core_course_get_enrolled_courses_by_timeline_classification":
            return {"courses": [{**COURSE, "startdate": 2_000_000_000, "hidden": False}]}
        raise AssertionError(method)

    def download(self, cmid, typ, dest, max_bytes=None):
        dest.mkdir(parents=True, exist_ok=True)
        p = dest / f"{cmid}.pdf"
        p.write_bytes(make_pdf([f"Seite {cmid}"]))
        return [p]

    def deadlines(self, days=30):
        return [DEADLINE]


def fields(entry, cmid="100"):
    return {k: v for k, v in entry["cms"][cmid].items() if k in ("seen_at", "updated_at")}


def course(lw, old, since, ziel, now):
    entry, _ = sync.sync_course(lw, COURSE | {"fullname": "Kurs A"}, old, ziel, since, CFG, False, Counter(), now=now)
    return entry


# --------------------------------------------------------------------------- seen_at / updated_at

def test_new_activity_gets_seen_at_but_first_import_does_not(tmp_path):
    assert fields(course(FakeLW(), {}, None, tmp_path, 1000)) == {}  # Erstimport zählt nie als neu
    assert fields(course(FakeLW(), {}, 500, tmp_path, 1000)) == {"seen_at": 1000}  # später aufgenommener Kurs


def test_fields_survive_later_runs_and_updated_at_marks_changes(tmp_path):
    first = course(FakeLW(), {}, 500, tmp_path, 1000)
    second = course(FakeLW(), first, 1000, tmp_path, 2000)
    assert fields(second) == {"seen_at": 1000}  # unverändert: nichts neu, nichts aktualisiert
    third = course(FakeLW(changed=["100"]), second, 2000, tmp_path, 3000)
    assert fields(third) == {"seen_at": 1000, "updated_at": 3000}
    fourth = course(FakeLW(cms=[FOLIEN, NEU]), third, 3000, tmp_path, 4000)
    assert fields(fourth) == {"seen_at": 1000, "updated_at": 3000}
    assert fields(fourth, "101") == {"seen_at": 4000}


def test_old_state_without_the_fields_stays_old(tmp_path):
    old = course(FakeLW(), {}, None, tmp_path, 1000)  # so sieht der heutige State aus
    assert "seen_at" not in old["cms"]["100"]
    again = course(FakeLW(), old, 1000, tmp_path, 2000)
    assert fields(again) == {}


# --------------------------------------------------------------------------- run / main

def prepare(tmp_path, monkeypatch, lw=None):
    ziel = tmp_path / "vault"
    sync.save_json(sync.CONFIG, {**CFG, "ziel": str(ziel)})
    monkeypatch.setattr(sync, "LearnWeb", lambda creds: lw or FakeLW())
    monkeypatch.setattr(sync.content, "update", lambda *a, **k: {"courses": 0, "news": 0, "assignments": 0, "teachers": 0, "errors": 0})  # eigene Tests in test_content.py
    monkeypatch.setattr(credentials, "username", lambda: "u")
    monkeypatch.setattr(credentials, "password", lambda u: "pw")
    return ziel


def stdout_events(capsys):
    cap = capsys.readouterr()
    return [json.loads(line) for line in cap.out.splitlines()], cap.err


def test_plain_output_is_exactly_the_old_log(tmp_path, monkeypatch, capsys):
    ziel = prepare(tmp_path, monkeypatch)
    assert sync.main([]) == 0
    lines = [re.sub(r"^\[[^\]]+\] ", "", ln) for ln in capsys.readouterr().out.splitlines()]
    assert lines == [f"1 Kurse ab 2020-01-01 → {ziel}",
                     "  " + "Kurs A".ljust(60) + "   1 Aktivitäten,   1 Dateien",
                     "Fertig: 1 Dateien geladen, 0 zu groß, 0 Fehler, 0 Änderungen gemeldet."]


def test_json_mode_stdout_is_only_json_lines(tmp_path, monkeypatch, capsys):
    ziel = prepare(tmp_path, monkeypatch)
    assert sync.main(["--json"]) == 0
    events, err = stdout_events(capsys)
    assert [e["event"] for e in events] == ["start", "file", "course", "content", "events", "schedule", "index", "suggest", "verzeichnis", "done"]  # course = Kurs fertig
    assert events[0] == {"event": "start", "courses": 1, "dry": False}
    assert events[1]["path"] == "Kurs A/01 Woche 1/100.pdf" and events[1]["new"] is True
    assert events[2]["name"] == "Kurs A" and events[2]["index"] == 1 and events[2]["total"] == 1
    assert events[3]["event"] == "content" and events[4] == {"event": "events", "count": 0} and events[5] == {"event": "schedule", "count": 0, "with_time": 0}
    assert events[6]["indexed"] == 1 and events[7] == {"event": "suggest", "count": 0} and events[8] == {"event": "verzeichnis", "semester": 1, "kurse": 1, "geschrieben": True}
    assert events[9] == {"event": "done", "files": 1, "skipped": 0, "errors": 0, "changes": 0}
    assert "100.pdf" in (ziel / "_Verzeichnis.md").read_text(encoding="utf-8")
    assert "Kurse ab 2020-01-01" in err  # Logzeilen gibt es weiter, nur eben auf stderr


def test_run_writes_deadlines_state_and_index(tmp_path, monkeypatch):
    ziel = prepare(tmp_path, monkeypatch)
    started = int(time.time())
    assert sync.main(["--json"]) == 0
    d = json.loads(sync.DEADLINES.read_text(encoding="utf-8"))
    assert d["items"] == [DEADLINE] and d["updated"] >= started - 1
    assert json.loads(sync.STATE.read_text(encoding="utf-8"))["courses"]["7"]["cms"]["100"]["files"] == ["Kurs A/01 Woche 1/100.pdf"]
    assert (ziel / "_Fristen.md").exists()
    assert json.loads(sync.EVENTS.read_text(encoding="utf-8"))["items"] == []  # Abschnitt "Woche 1" hat kein Datum
    assert index.search(sync.INDEX, "seite")[0]["path"] == "Kurs A/01 Woche 1/100.pdf"
    assert not sync.LOCK.exists()


def test_second_run_marks_the_new_activity(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, monkeypatch)
    sync.main(["--json"])
    capsys.readouterr()
    monkeypatch.setattr(sync, "LearnWeb", lambda creds: FakeLW(cms=[FOLIEN, NEU]))
    assert sync.main(["--json"]) == 0
    events, _ = stdout_events(capsys)
    assert [e["path"] for e in events if e["event"] == "file"] == ["Kurs A/01 Woche 1/101.pdf"]
    cms = json.loads(sync.STATE.read_text(encoding="utf-8"))["courses"]["7"]["cms"]
    assert "seen_at" not in cms["100"] and cms["101"]["seen_at"] > 0
    assert events[-1]["changes"] == 1


def test_dry_run_json_writes_nothing(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, monkeypatch)
    assert sync.main(["--json", "--dry-run"]) == 0
    events, _ = stdout_events(capsys)
    assert [e["event"] for e in events] == ["start", "course", "done"] and events[-1] == {"event": "done", "dry": True, "would_load": 1}
    assert not sync.STATE.exists() and not sync.DEADLINES.exists() and not sync.LOCK.exists()


def test_index_failure_does_not_fail_the_sync(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, monkeypatch)
    monkeypatch.setattr(sync.index, "update", lambda *a, **k: (_ for _ in ()).throw(OSError("Platte voll")))
    assert sync.main(["--json"]) == 0
    events, err = stdout_events(capsys)
    assert any(e["event"] == "index" and "Platte voll" in e["error"] for e in events)
    assert "Suchindex nicht aktualisiert" in err and events[-1]["event"] == "done"


# --------------------------------------------------------------------------- Sperre

def test_live_lock_blocks_with_exit_2_and_stays(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, monkeypatch)
    sync.LOCK.parent.mkdir(parents=True, exist_ok=True)
    sync.LOCK.write_text(str(os.getpid()))
    assert sync.main(["--json"]) == 2
    events, _ = stdout_events(capsys)
    assert events == [{"event": "error", "code": "locked", "message": "Ein anderer Sync läuft noch (data/sync.lock)."}]
    assert sync.LOCK.exists()


def test_lock_of_dead_process_or_older_than_2h_is_stale(tmp_path, monkeypatch):
    prepare(tmp_path, monkeypatch)
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    sync.LOCK.parent.mkdir(parents=True, exist_ok=True)
    sync.LOCK.write_text(str(p.pid))
    assert not sync.lock_active()
    sync.LOCK.write_text(str(os.getpid()))
    old = time.time() - 3 * 3600
    os.utime(sync.LOCK, (old, old))
    assert not sync.lock_active()
    sync.LOCK.write_text(str(os.getpid()))
    assert sync.lock_active()
    sync.LOCK.write_text("kein pid")
    assert sync.lock_active()  # unlesbar: lieber vorsichtig
    sync.LOCK.write_text(str(p.pid))
    assert sync.main([]) == 0 and not sync.LOCK.exists()


# --------------------------------------------------------------------------- Fehlercodes

@pytest.mark.parametrize("exc, code", [(LoginError("Ungültige Anmeldedaten"), "login"),
                                       (httpx.ConnectError("weg"), "network"),
                                       (credentials.NoCredentials("keine"), "credentials"),
                                       (KeyError("x"), "internal")])
def test_json_mode_maps_failures_to_error_events(tmp_path, monkeypatch, capsys, exc, code):
    prepare(tmp_path, monkeypatch)

    class Boom(FakeLW):
        def ajax(self, method, args):
            raise exc

    monkeypatch.setattr(sync, "LearnWeb", lambda creds: Boom())
    if code == "credentials":
        monkeypatch.setattr(credentials, "username", lambda: (_ for _ in ()).throw(exc))
    assert sync.main(["--json"]) == 1
    events, _ = stdout_events(capsys)
    assert events[-1]["event"] == "error" and events[-1]["code"] == code
    assert not sync.LOCK.exists()


def test_plain_mode_still_raises_unexpected_errors(tmp_path, monkeypatch):
    prepare(tmp_path, monkeypatch)
    monkeypatch.setattr(sync, "LearnWeb", lambda creds: (_ for _ in ()).throw(httpx.ConnectError("weg")))
    with pytest.raises(httpx.ConnectError):
        sync.main([])
