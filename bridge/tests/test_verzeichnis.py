"""Verzeichnis (_Verzeichnis.md, verzeichnis.json): Aufbau, Inhalt und sparsames Schreiben. Nur Testdaten im Temp-Ordner."""
import json
import os

import pytest
from helpers import make_pdf, make_pptx, make_state, put

from learnweb import cli, index, sync, verzeichnis


@pytest.mark.parametrize("name, expected", [
    ("Gulliver's Travels at 300 WiSe 2026/27, Kirsten Juhas", ("Gulliver's Travels at 300", "WiSe 2026/27", "Kirsten Juhas")),
    ("Unterrichten im Sport - Begleitseminare WiSe 2026-2027", ("Unterrichten im Sport - Begleitseminare", "WiSe 2026/27", None)),
    ("Tennis Plus SoSe 2026, Axel Binnenbruck, Brunert Willi", ("Tennis Plus", "SoSe 2026", "Axel Binnenbruck, Brunert Willi")),
    ("Wahlverfahren WiSe 2026 Sportwissenschaft - Kohorte WiSe 24/25 (5. FS)", ("Wahlverfahren Sportwissenschaft - Kohorte WiSe 24/25 (5. FS)", "WiSe 2026/27", None)),
    ("GK2 Intro to Literary + Cultural Studies", ("GK2 Intro to Literary + Cultural Studies", None, None)),
    ("SoSe 2026", ("SoSe 2026", "SoSe 2026", None)),
])
def test_split_name_matches_the_app(name, expected):
    assert verzeichnis.split_name(name) == expected


def setup(tmp_path):
    ziel = tmp_path / "vault"
    put(ziel, "Kurs A/01 Woche/Folien.pdf", make_pdf(["Einleitung zur Gruppendynamik", "Zweite Seite", "Dritte Seite"]))
    put(ziel, "Kurs A/01 Woche/Scan.pdf", make_pdf([""]))
    put(ziel, "Kurs A/02 Woche/Deck.pptx", make_pptx(["Titelfolie Kohäsion", "Folie zwei"]))
    state = make_state([(1, "resource", "Folien Woche 1", ["Kurs A/01 Woche/Folien.pdf"]), (2, "resource", "Scan", ["Kurs A/01 Woche/Scan.pdf"]),
                        (3, "resource", "Deck", ["Kurs A/02 Woche/Deck.pptx"]), (4, "resource", "Riesig", []),
                        (5, "forum", "Ankündigungen", []), (6, "label", "The deadline is 1 December 2026, 12 noon.", []),
                        (7, "resource", "Weg", ["Kurs A/00 weg/fehlt.pdf"])],
                       course_id=7, name="Kurs A WiSe 2026/27, Dozentin Beispiel", dir_="Kurs A")
    c = state["courses"]["7"]
    c["layout"] = [["12 October: Einführung", ["1", "2", "6", "7"]], ["Material", ["3", "4", "5"]]]
    c["cms"]["4"]["skipped"] = [{"mb": 34.2}]
    for cm, sec in zip(c["cms"].values(), ["01 Woche"] * 2 + ["02 Woche"] * 5):
        cm["section"] = sec
    state["courses"]["9"] = {"id": 9, "name": "Kurs B SoSe 2026", "url": "https://x/c9", "dir": "Kurs B", "layout": [["Session I, 24.04.2026", []]], "cms": {}}
    state["courses"]["11"] = {"id": 11, "name": "Ohne Semester", "url": None, "dir": "Ohne", "layout": [], "cms": {}}
    db = tmp_path / "idx.db"
    index.update(state, ziel, db)
    return ziel, state, db


def test_build_orders_semesters_and_describes_every_file(tmp_path):
    ziel, state, db = setup(tmp_path)
    v = verzeichnis.build(state, ziel, db, stand="2026-10-14 13:40")
    assert [s["name"] for s in v["semester"]] == ["WiSe 2026/27", "SoSe 2026", "Weitere"]
    a = v["semester"][0]["kurse"][0]
    assert (a["id"], a["titel"], a["dozent"], a["notiz"]) == (7, "Kurs A", "Dozentin Beispiel", "Kurs A/Kurs A.md")
    w1, w2 = a["abschnitte"]
    assert w1["datum"] == "2026-10-12" and w2["datum"] is None
    folien, scan, label, weg = w1["eintraege"]
    f = folien["dateien"][0]
    assert (f["pfad"], f["name"], f["ext"], f["seiten"], f["text"]) == ("Kurs A/01 Woche/Folien.pdf", "Folien.pdf", "pdf", 3, "ja")
    assert f["bytes"] > 0 and f["anfang"].startswith("Einleitung zur Gruppendynamik")
    assert scan["dateien"][0]["text"] == "leer" and scan["dateien"][0]["anfang"] is None
    assert label == {"cmid": 6, "typ": "label", "text": "The deadline is 1 December 2026, 12 noon."}
    assert weg["dateien"][0]["bytes"] is None  # im State, aber nicht (mehr) auf der Platte
    deck, riesig, forum = w2["eintraege"]
    assert deck["dateien"][0]["seiten"] == 2 and riesig["zu_gross_mb"] == [34.2] and riesig["dateien"] == [] and forum["typ"] == "forum"
    assert v["semester"][1]["kurse"][0]["abschnitte"][0]["datum"] == "2026-04-24"  # Jahr aus SoSe 2026


def test_build_without_an_index_still_lists_everything(tmp_path):
    ziel, state, _ = setup(tmp_path)
    v = verzeichnis.build(state, ziel, tmp_path / "gibt-es-nicht.db")
    f = v["semester"][0]["kurse"][0]["abschnitte"][0]["eintraege"][0]["dateien"][0]
    assert f["seiten"] is None and f["text"] is None and f["anfang"] is None and f["bytes"] > 0


def test_markdown_is_the_entry_point_for_people_and_assistants(tmp_path):
    ziel, state, db = setup(tmp_path)
    md = verzeichnis.markdown(verzeichnis.build(state, ziel, db, stand="2026-10-14 13:40"))
    for needle in ["tags: [learnweb, verzeichnis]", "# LearnWeb – Verzeichnis", "Für KI-Assistenten", "verzeichnis.json",
                   "3 Semester · 3 Kurse · 4 Dateien", "## WiSe 2026/27", "### Kurs A — Dozentin Beispiel", "Kurs-ID 7",
                   "**12 October: Einführung** (2026-10-12)", "[Folien Woche 1](<Kurs A/01 Woche/Folien.pdf>) — PDF · 3 S. ·",
                   "„Einleitung zur Gruppendynamik", "Text: leer", "- The deadline is 1 December 2026, 12 noon.",
                   "zu groß (34.2 MB), nur in LearnWeb", "## SoSe 2026", "## Weitere"]:
        assert needle in md, needle
    assert md.index("## WiSe 2026/27") < md.index("## SoSe 2026") < md.index("## Weitere")


def test_update_writes_only_when_the_content_changes(tmp_path):
    ziel, state, db = setup(tmp_path)
    r1 = verzeichnis.update(state, ziel, db, sync.write_text, "2026-10-14 13:40")
    assert r1["geschrieben"] and (ziel / "_Verzeichnis.md").exists() and (ziel / "verzeichnis.json").exists()
    data = json.loads((ziel / "verzeichnis.json").read_text(encoding="utf-8"))
    assert data["erzeugt"] == "2026-10-14 13:40" and len(data["semester"]) == 3
    old = os.stat(ziel / "_Verzeichnis.md").st_mtime_ns
    r2 = verzeichnis.update(state, ziel, db, sync.write_text, "2026-10-15 07:15")  # nur der Zeitstempel ist neu
    assert not r2["geschrieben"] and os.stat(ziel / "_Verzeichnis.md").st_mtime_ns == old
    state["courses"]["9"]["name"] = "Kurs B geändert SoSe 2026"
    assert verzeichnis.update(state, ziel, db, sync.write_text, "2026-10-15 07:16")["geschrieben"]
    assert "Kurs B geändert" in (ziel / "_Verzeichnis.md").read_text(encoding="utf-8")


def test_cli_builds_it_from_the_state_without_network(tmp_path, capsys):
    ziel, state, db = setup(tmp_path)
    assert cli.main(["verzeichnis"]) == 1  # noch kein State
    capsys.readouterr()
    sync.save_json(sync.STATE, state)
    sync.save_json(sync.CONFIG, {**sync.DEFAULT_CONFIG, "ziel": str(ziel)})
    assert cli.main(["verzeichnis"]) == 0
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert res == {"ok": True, "semester": 3, "kurse": 3, "geschrieben": True}
