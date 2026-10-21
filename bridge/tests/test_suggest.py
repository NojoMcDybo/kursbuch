"""Vorschlaege fuer Termine und Fristen aus Kurstexten (suggest.py): Datumsformen, Jahr, Rauschen, Art, Zeitraeume, Index."""
import datetime as dt
import json
import sqlite3
import time

import pytest

from learnweb import suggest

TODAY = dt.date(2026, 10, 21)


def days(text, **kw):
    return [(s["day"], s["kind"], s["confidence"]) for s in suggest.extract(text, TODAY, **kw)]


def test_german_and_english_date_forms_with_a_keyword():
    assert days("Abgabe bis 15.12.2026") == [("2026-12-15", "frist", "hoch")]
    assert days("The deadline is 22 January 2027, 12 noon.") == [("2027-01-22", "frist", "hoch")]
    assert days("Submission Deadline: March 5, 2027") == [("2027-03-05", "frist", "hoch")]
    assert days("Klausur am 19. März 2027 in H1") == [("2027-03-19", "pruefung", "hoch")]
    assert days("Prüfung: 2027-02-03") == [("2027-02-03", "pruefung", "hoch")]
    assert days("Final exam on 3rd February 2027") == [("2027-02-03", "pruefung", "hoch")]


def test_without_a_keyword_a_date_is_nothing():
    assert days("Wir treffen uns am 12.11.2026 im Hörsaal.") == []  # kein Stichwort
    assert days("Sitzung 4: 12 November 2026, Thema: Lernen") == []


def test_year_comes_from_the_course_semester_the_page_or_the_next_occurrence():
    sose = suggest.semester_span("Turnen SoSe 2026, Dittrich")
    wise = suggest.semester_span("Akrobatik WiSe 2026/27")
    assert sose == (dt.date(2026, 3, 15), dt.date(2026, 10, 15)) and wise == (dt.date(2026, 9, 15), dt.date(2027, 4, 15))
    assert suggest.semester_span("Kurs ohne Semester") is None
    # SoSe 2026: der 27.07. liegt im Sommer 2026 (vorbei), nie im Sommer 2027
    assert days("Klausur 27.07.", span=sose) == []
    # WiSe 2026/27: der 10.02. liegt im Februar 2027
    assert days("Prüfungsshow 10.02. Beginn 19 Uhr", span=wise)[0][0] == "2027-02-10"
    # ohne Semester: die Jahreszahl der Seite (Juli 2026 ist vorbei)
    assert days("exam info version 21JUL2026 ... the exam on 27 July. Good luck") == []
    assert days("Prüfungsinfo 2027: Klausur am 27.07.")[0][0] == "2027-07-27"
    # sonst das naechste passende Datum
    assert days("Abgabe bis 3.11.")[0][0] == "2026-11-03"


def test_time_window_drops_old_and_far_dates():
    assert days("Abgabe bis 15.12.2024") == []  # lange vorbei
    assert days("Abgabe bis 15.12.2030") == []  # zu weit
    assert days("Abgabe bis 19.10.2026") == []  # vorgestern
    assert days("Abgabe bis 20.10.2026")[0][0] == "2026-10-20"  # gestern und heute zaehlen noch (Zeitzonen, Spaetabgabe)
    assert days("Abgabe bis 21.10.2026")[0][0] == "2026-10-21"


def test_noise_around_a_date_is_ignored():
    stamp = "an argument about identity. This content downloaded from 95.90.184.75 on Tue, 27 Apr 2027 07:44:26 UTC All use subject to terms"
    assert days(stamp) == []
    assert days("Smith, J. (2026). Title. Accessed 15 November 2026 at http://example.org/exam-paper") == []
    assert days("See Quote 4.5. for the exam setting") == []  # Abschnittsnummer, kein 4. Mai
    assert days("Kapitel 3.1. Klausurtechniken") == []


def test_a_keyword_belongs_to_the_nearest_date_only():
    syllabus = "12 October General Introduction 19 October An Introduction to Satire 26 October Conference: Celebrating 300 Years of Gulliver"
    assert days(syllabus) == [("2026-10-26", "termin", "mittel")]
    # Tabelle: „Abgabe“ steht bei der zweiten Zahl
    assert days("Termin 21.10.26 Präsenz  Aufgabe 1 Mind-Map (bis 18.11.26)") == [("2026-11-18", "frist", "hoch")]


def test_a_range_gives_one_deadline_at_its_end():
    assert days("QISPOS registration phase: 26 Oct – 15 Dec 2026") == [("2026-12-15", "frist", "mittel")]
    assert days("Anmeldung vom 26.10. bis zum 15.12.26") == [("2026-12-15", "frist", "hoch")]


def test_exam_beats_deadline_and_time_is_read():
    out = suggest.extract("Klausur und Abgabe am 24.07.2027, 16:00 – 17:00 Uhr", TODAY)
    assert [(s["kind"], s["all_day"]) for s in out] == [("pruefung", False)]
    assert time.localtime(out[0]["ts"])[3:5] == (16, 0)
    assert suggest.extract("Abgabe bis 15.12.2026", TODAY)[0]["all_day"] is True


def test_short_title_is_the_text_up_to_the_date():
    short = lambda text: suggest.extract(text, TODAY)[0]["short"]  # noqa: E731
    assert short("Die Abgabe des Essays erfolgt bis 27.10.2026 über LearnWeb.") == "Die Abgabe des Essays erfolgt bis 27.10.2026"
    assert short("Klausur 19.03.2027") == "Klausur 19.03.2027"
    assert len(short("x " * 60 + "Abgabe bis 27.10.2026")) <= 46


def test_ids_are_stable_and_change_with_the_text():
    a = suggest.extract("Abgabe bis 15.12.2026", TODAY, course_id=7)[0]["id"]
    assert a == suggest.extract("Abgabe bis 15.12.2026", TODAY, course_id=7)[0]["id"]
    assert a != suggest.extract("Abgabe bis 15.12.2026", TODAY, course_id=8)[0]["id"]
    assert a.startswith("s-") and len(a) == 14


@pytest.fixture
def index(tmp_path):
    db = tmp_path / "index.db"
    c = sqlite3.connect(db)
    c.execute("create table entries (id integer primary key, course_id integer, cmid integer, path text, kind text, title text, page integer)")
    c.execute("create virtual table fts using fts5(title, body)")
    rows = [
        (1, 7, "pdf", "Folien.pdf", 4, "Die Klausur findet am 19.03.2027 statt."),
        (2, 7, "news", "Hinweis", None, "Abgabe der Hausarbeit bis 15.12.2026 über LearnWeb."),
        (3, 8, "pdf", "Literatur.pdf", 2, "Smith 2020. Accessed 15 November 2026 at http://x.org"),
        (4, 7, "section", "Woche 3", None, "Klausur 02.02.2027"),  # Abschnitte liest events.py, nicht dieses Modul
    ]
    for rid, course, kind, title, page, body in rows:
        c.execute("insert into entries values (?,?,?,?,?,?,?)", (rid, course, None, "p", kind, title, page))
        c.execute("insert into fts(rowid, title, body) values (?,?,?)", (rid, title, body))
    c.commit()
    c.close()
    return db


def test_build_reads_the_index_and_drops_known_dates(index):
    items = suggest.build(index, [], [], TODAY, {7: "Kurs A WiSe 2026/27", 8: "Kurs B"})
    assert [(i["day"], i["kind"], i["source"]) for i in items] == [
        ("2026-12-15", "frist", "Ankündigung · Hinweis"), ("2027-03-19", "pruefung", "Folien.pdf · Seite 4")]
    # events.json kennt die Klausur schon, LearnWeb die Abgabe: beides faellt weg
    known = [{"course_id": 7, "day": "2027-03-19", "kind": "pruefung"}]
    dl = [{"kurs_id": 7, "faellig": "2026-12-15 23:55", "titel": "Hausarbeit"}]
    assert suggest.build(index, known, dl, TODAY, {7: "Kurs A WiSe 2026/27"}) == []
    # eine Abgabe, die als Pruefung bekannt ist, gilt als derselbe Termin
    same = [{"course_id": 7, "day": "2026-12-15", "kind": "pruefung"}]
    assert [i["day"] for i in suggest.build(index, same, [], TODAY, {7: "Kurs A WiSe 2026/27"})] == ["2027-03-19"]
    assert suggest.build(index.parent / "gibt-es-nicht.db", [], [], TODAY) == []


def test_update_writes_the_file_for_known_courses_only(index):
    saved = {}
    res = suggest.update({"courses": {"7": {"name": "Kurs A WiSe 2026/27"}}}, [], [], index, saved.update, now=123, today=TODAY)
    assert res == {"count": 2} and saved["updated"] == 123
    assert {i["course_id"] for i in saved["items"]} == {7}
    json.dumps(saved)  # serialisierbar
