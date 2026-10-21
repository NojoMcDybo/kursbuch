"""Suchindex: nur mit Testdaten im Temp-Ordner.   uv run --with pytest pytest -q"""
import os
import sqlite3
from pathlib import Path

import pytest
from helpers import make_docx, make_encrypted_pdf, make_pdf, make_pptx, make_state, put

from learnweb import index

REL = "Kurs/01 Woche 1/Folien.pdf"


def pdf_course(tmp_path, pages, name="Sportpsychologie"):
    ziel = tmp_path / "vault"
    put(ziel, REL, make_pdf(pages))
    return ziel, make_state([(100, "resource", "Folien Woche 1", [REL])], name=name)


def hits(db, q, kind):
    return [h for h in index.search(db, q) if h["kind"] == kind]


def test_pdf_hit_has_page_snippet_and_ids(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Einleitung", "Gruppendynamik und Kohäsion im Team", "Schluss"])
    r = index.update(state, ziel, db)
    assert r["indexed"] == 1 and r["errors"] == 0
    h = hits(db, "kohäsion", "pdf")[0]
    assert (h["page"], h["path"], h["cmid"], h["course_id"]) == (2, REL, 100, 7)
    assert "\x01" in h["snippet"] and "\x02" in h["snippet"]
    assert hits(db, "kohasion", "pdf")[0]["page"] == 2  # ohne Umlaut
    assert hits(db, "gruppendyn", "pdf")[0]["page"] == 2  # Präfix, schon beim Tippen


@pytest.mark.parametrize("query", ["grosse", "große", "STRASSE", "straße"])
def test_sharp_s_matches_both_spellings(tmp_path, db, query):
    ziel, state = pdf_course(tmp_path, ["Große Übung zur Straße"])
    index.update(state, ziel, db)
    assert hits(db, query, "pdf")


TREMA = chr(0x308)  # kombinierendes Trema: PDFs liefern "ä" oft als a + Trema
BULLET = chr(0xF0B7)  # Aufzählungszeichen aus Wingdings/Symbol (privater Unicode-Bereich)


def test_text_is_cleaned_for_display_and_matching():
    assert index.clean(f"Koha{TREMA}sion\n\n {BULLET}  Punkt\x0c eins") == f"Koha{TREMA}sion Punkt eins"
    assert index.norm(f"Koha{TREMA}sion Straße") == "Kohäsion Strasse"  # zusammengesetzt, ß -> ss


def test_decomposed_umlauts_and_symbol_bullets_do_not_reach_the_snippet(tmp_path, db, monkeypatch):
    ziel, state = pdf_course(tmp_path, ["x"])
    monkeypatch.setitem(index._EXTRACT, "pdf", lambda path: iter([(3, f"{BULLET} Koha{TREMA}sion im Team")]))
    index.update(state, ziel, db)
    h = hits(db, "kohasion", "pdf")[0]
    assert h["page"] == 3 and BULLET not in h["snippet"] and TREMA not in h["snippet"]
    assert h["snippet"].replace("\x01", "").replace("\x02", "").strip() == "Kohäsion im Team"


def test_names_rank_above_file_text(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Gruppendynamik Gruppendynamik Gruppendynamik"], name="Gruppendynamik Seminar")
    index.update(state, ziel, db)
    assert index.search(db, "gruppendynamik")[0]["kind"] == "course"


def test_labels_are_not_indexed_but_sections_and_activities_are(tmp_path, db):
    state = make_state([(1, "label", "Hinweistext Zeitplan", []), (2, "forum", "Ankündigungen", [])])
    index.update(state, tmp_path, db)
    assert not index.search(db, "hinweistext")
    assert index.search(db, "ankündigungen")[0]["kind"] == "activity"
    assert index.search(db, "woche")[0]["kind"] == "section"


def test_docx_and_pptx(tmp_path, db):
    ziel = tmp_path / "vault"
    put(ziel, "Kurs/a.docx", make_docx(["Erste Zeile", "Motivationstheorie nach Deci und Ryan"]))
    put(ziel, "Kurs/b.pptx", make_pptx(["Titelfolie", "Selbstbestimmungstheorie"]))
    state = make_state([(1, "resource", "A", ["Kurs/a.docx"]), (2, "resource", "B", ["Kurs/b.pptx"])])
    assert index.update(state, ziel, db)["indexed"] == 2
    d = hits(db, "motivationstheorie", "docx")[0]
    assert d["page"] is None and d["cmid"] == 1
    assert hits(db, "selbstbestimmungstheorie", "pptx")[0]["page"] == 2  # Folie 2


def test_incremental_change_and_removal(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Alttext Periodisierung"])
    assert index.update(state, ziel, db)["indexed"] == 1
    r = index.update(state, ziel, db)
    assert (r["indexed"], r["unchanged"]) == (0, 1)

    p = put(ziel, REL, make_pdf(["Neutext Superkompensation"]))
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 10))
    assert index.update(state, ziel, db)["indexed"] == 1
    assert hits(db, "superkompensation", "pdf") and not hits(db, "periodisierung", "pdf")

    (ziel / REL).unlink()  # auf der Platte weg
    r = index.update(state, ziel, db)
    assert r["removed"] == 1 and not hits(db, "superkompensation", "pdf")

    put(ziel, REL, make_pdf(["Wieder da"]))  # wieder da, aber nicht mehr im State
    index.update(state, ziel, db)
    state["courses"]["7"]["cms"]["100"]["files"] = []
    assert index.update(state, ziel, db)["removed"] == 1 and not hits(db, "wieder", "pdf")


def test_broken_encrypted_and_empty_files_are_noted_not_fatal(tmp_path, db):
    ziel = tmp_path / "vault"
    put(ziel, "Kurs/gut.pdf", make_pdf(["Belastungsnormative"]))
    put(ziel, "Kurs/kaputt.pdf", b"%PDF-1.4 das ist kein PDF")
    put(ziel, "Kurs/leer.pdf", make_pdf([""]))
    put(ziel, "Kurs/zu.pdf", make_encrypted_pdf(["Geheimtext"]))
    state = make_state([(i, "resource", n, [f"Kurs/{n}.pdf"]) for i, n in enumerate(["gut", "kaputt", "leer", "zu"], 1)])
    r = index.update(state, ziel, db)
    assert hits(db, "belastungsnormative", "pdf")
    assert not hits(db, "geheimtext", "pdf")
    assert (r["errors"], r["empty"]) == (2, 1)
    con = sqlite3.connect(db)
    notes = dict(con.execute("SELECT path, status || ': ' || note FROM files").fetchall())
    con.close()
    assert notes["Kurs/kaputt.pdf"].startswith("error: ") and "verschlüsselt" in notes["Kurs/zu.pdf"]
    assert notes["Kurs/leer.pdf"].startswith("empty: ")
    assert index.update(state, ziel, db)["indexed"] == 0  # Fehlerhafte werden nicht bei jedem Lauf neu versucht


def test_moved_activity_updates_ids_without_reindexing(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Taktik"])
    index.update(state, ziel, db)
    cm = state["courses"]["7"]["cms"].pop("100")
    state["courses"]["7"]["cms"]["555"] = cm
    r = index.update(state, ziel, db)
    assert r["indexed"] == 0 and hits(db, "taktik", "pdf")[0]["cmid"] == 555


def test_rebuild_gives_same_result(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Taktik", "Technik"])
    first = index.update(state, ziel, db)
    again = index.update(state, ziel, db, rebuild=True)
    assert again["entries"] == first["entries"] and again["indexed"] == 1


@pytest.mark.parametrize("q", ["", "   ", 'AND OR NEAR ( " *', "a:b -c ^d", "'; DROP TABLE entries; --"])
def test_search_input_never_breaks_the_query(tmp_path, db, q):
    ziel, state = pdf_course(tmp_path, ["Taktik"])
    index.update(state, ziel, db)
    assert isinstance(index.search(db, q), list)
    assert sqlite3.connect(db).execute("SELECT COUNT(*) FROM entries").fetchone()[0] > 0


def test_search_without_index_is_empty_and_stats_do_not_create_it(tmp_path, db):
    assert index.search(db, "x") == [] and index.stats(db) == {"exists": False}
    assert not Path(db).exists()


def test_stats_after_update(tmp_path, db):
    ziel, state = pdf_course(tmp_path, ["Taktik"])
    index.update(state, ziel, db)
    s = index.stats(db)
    assert s["exists"] and s["files"] == 1 and s["errors"] == 0 and s["built_at"] and s["entries"] >= 3
