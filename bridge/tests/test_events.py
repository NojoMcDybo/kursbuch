"""Termin-Parser: Beispiele aus den echten Kursen und Eigenschaften (Hypothesis), die fuer jedes Datum gelten muessen."""
from datetime import date, datetime

import pytest
from hypothesis import given, settings, strategies as st

from learnweb import events

TODAY = date(2026, 10, 14)
WISE = ("WiSe", 2026)
SOSE = ("SoSe", 2026)


def dates(text, sem=WISE):
    return [events.resolve(h, sem, TODAY) for h in events.find_dates(text)]


# --------------------------------------------------------------------------- echte Titel

@pytest.mark.parametrize("text, sem, expected", [
    ("12 October: Introduction", WISE, [date(2026, 10, 12)]),
    ("26 October: 300 Years of Gulliver's Travels - Conference at the Schloss", WISE, [date(2026, 10, 26)]),
    ("Introduction / overview (15 October, digital-only session)", WISE, [date(2026, 10, 15)]),
    ("The parts of a simple sentence I (5 November, hybrid session)", WISE, [date(2026, 11, 5)]),
    ("Overview (14 January)", WISE, [date(2027, 1, 14)]),  # Jahr aus dem Semester: WiSe 2026/27 -> Januar 2027
    ("April 23 | \"Queer\" What?", SOSE, [date(2026, 4, 23)]),
    ("Session I, 24.04.2026: Criteria CCOT", SOSE, [date(2026, 4, 24)]),
    ("Session 2_ 05.06.26_ Focus on Oracy", SOSE, [date(2026, 6, 5)]),
    ("The deadline is 1 December 2026, 12 noon.", WISE, [date(2026, 12, 1)]),
    ("Date and place: Monday, 27 July 2026", SOSE, [date(2026, 7, 27)]),
    ("two examination slots on 27.7.2026", SOSE, [date(2026, 7, 27)]),
    ("Abgabe bis 15. Januar 2027", WISE, [date(2027, 1, 15)]),
    ("Klausur am 3. März", WISE, [date(2027, 3, 3)]),
    ("2026-10-14", None, [date(2026, 10, 14)]),
])
def test_real_titles(text, sem, expected):
    assert dates(text, sem) == expected


def test_lists_ranges_and_ambiguous_numbers():
    assert dates("12 & 19 October") == [date(2026, 10, 12), date(2026, 10, 19)]
    assert dates("12 and 19 October") == [date(2026, 10, 12), date(2026, 10, 19)]
    assert dates("12-16 October") == [date(2026, 10, 12)]  # Bereich: der Beginn
    assert dates("Session 2, 12 October") == [date(2026, 10, 12)]  # nicht auch der 2.
    assert dates("Week 3 - 12 October") == [date(2026, 10, 12)]
    assert dates("Chapter 3.4.5") == []  # Gliederungsnummer, kein Datum
    assert dates("see version 1.2.3") == []
    assert dates("you may submit 5 pages") == []  # "may" als Verb
    assert dates("May 5") == [date(2027, 5, 5)]  # WiSe 2026/27 -> Mai 2027
    assert dates("October 2026") == []  # Monat und Jahr, kein Tag
    assert dates("30 February") == [None]  # gibt es nicht
    assert dates("12 October 5 pages") == [date(2026, 10, 12)]  # "October 5" überlappt, der frühere Fund gewinnt


def test_without_semester_the_nearest_year_wins():
    h = events.find_dates("5 November")[0]
    assert events.resolve(h, None, date(2026, 10, 14)) == date(2026, 11, 5)
    assert events.resolve(h, None, date(2027, 1, 20)) == date(2026, 11, 5)  # 76 Tage zurueck statt 290 voraus
    h = events.find_dates("3 January")[0]
    assert events.resolve(h, None, date(2026, 12, 20)) == date(2027, 1, 3)


def test_time_after_the_date():
    t = "The deadline is 1 December 2026, 12 noon."
    h = events.find_dates(t)[0]
    assert events.time_after(t, h.end) == (12, 0)
    for text, expected in [("12 October, 14:30 Uhr", (14, 30)), ("12 October at 10 a.m.", (10, 0)), ("12 October, 3 pm", (15, 0)),
                           ("12 October um 9.15 h", (9, 15)), ("12 October, 15 students", None), ("12 October, 12 am.", (0, 0)),
                           ("12 October, 25:00 Uhr", None), ("12 October", None),
                           ("Mo., 20.07.26 | 11.00 Uhr bis 20:00 Uhr", (11, 0)), ("Do, 30.07.2026; 10:00 bis 12:00 Uhr", (10, 0)),
                           ("12 October, 10:75", None), ("12 October 3:2", None), ("12 October, 2026:", None)]:
        assert events.time_after(text, events.find_dates(text)[0].end) == expected, text


def test_kinds():
    assert events.kind_of("The deadline is 1 December", "label") == "frist"
    assert events.kind_of("Abgabe Aufgabe 1", "label") == "frist"
    assert events.kind_of("GK2 exam information", "label") == "pruefung"
    assert events.kind_of("Klausur", "abschnitt") == "pruefung"
    assert events.kind_of("Introduction", "abschnitt") == "sitzung"
    assert events.kind_of("Hinweis", "label") == "termin"


def test_semester_of():
    assert events.semester_of("Gulliver's Travels at 300 WiSe 2026/27, Kirsten Juhas") == ("WiSe", 2026)
    assert events.semester_of("Tennis Plus SoSe 2026, Axel") == ("SoSe", 2026)
    assert events.semester_of("GK2 Intro to Literary + Cultural Studies") is None
    assert events.semester_of("MySoSe 2026") is None


# --------------------------------------------------------------------------- build

def state():
    return {"courses": {
        "7": {"id": 7, "name": "Kurs A WiSe 2026/27, Dozent", "layout": [["12 October: Introduction", ["1"]], ["Material", ["2"]], ["Abgabe bis 15. Januar 2027", []]],
              "cms": {"1": {"name": "Slides", "typ": "resource"},
                      "2": {"name": "The deadline is 1 December 2026, 12 noon.", "typ": "label"},
                      "3": {"name": "Hinweis ohne Datum", "typ": "label"},
                      "4": {"name": "Abgabe 3.3.2027", "typ": "resource"}}},  # Aktivitaeten (keine Labels) zaehlen nicht
        "9": {"id": 9, "name": "Kurs B SoSe 2026", "layout": [["Session I, 24.04.2026", []]], "cms": {}},
    }}


def test_build_from_sections_and_labels():
    items = events.build(state(), TODAY)
    assert [(e["course_id"], e["kind"], e["source"], e["all_day"]) for e in items] == [
        (9, "sitzung", "abschnitt", True), (7, "sitzung", "abschnitt", True), (7, "frist", "label", False), (7, "frist", "abschnitt", True)]
    assert datetime.fromtimestamp(items[2]["ts"]) == datetime(2026, 12, 1, 12, 0)
    assert [e["day"] for e in items] == ["2026-04-24", "2026-10-12", "2026-12-01", "2027-01-15"]
    assert items[1]["title"] == "12 October: Introduction" and items[1]["cmid"] is None and items[2]["cmid"] == 2
    assert len({e["id"] for e in items}) == len(items)
    assert events.build(state(), TODAY) == items  # gleiche Eingabe, gleiche Ausgabe (stabile IDs)


@pytest.mark.parametrize("text, expected", [
    ("12 October: Introduction", "Introduction"),
    ("Introduction / overview (15 October, digital-only session)", "Introduction / overview (digital-only session)"),
    ("26 October: 300 Years of Gulliver's Travels - Conference at the Schloss", "300 Years of Gulliver's Travels - Conference at the Schloss"),
    ("13.04. - Alltagswissen und Wissenschaft", "Alltagswissen und Wissenschaft"),
    ("April 23 | \"Queer\" What?", "\"Queer\" What?"),
    ("Session I, 24.04.2026: Criteria CCOT", "Session I - Criteria CCOT"),
    ("Session 2_ 05.06.26_ Focus on Oracy", "Session 2 - Focus on Oracy"),
    ("Session III, 19.06.26 Focus on Scaffolding --> Developing your CCOT", "Session III, Focus on Scaffolding --> Developing your CCOT"),
    ("Restewahl 1 - Mo, 24.08.26 | 11.00 Uhr bis 20:00 Uhr", "Restewahl 1 - 11.00 Uhr bis 20:00 Uhr"),
    ("Session 2026-05-07 Thursday (recorded lecture will be provided here)", "Session Thursday (recorded lecture will be provided here)"),
    ("Ohne Datum bleibt gleich", "Ohne Datum bleibt gleich"),
])
def test_clean_title_drops_the_date(text, expected):
    assert events.clean_title(text, events.find_dates(text)) == expected


def test_build_adds_the_short_title_for_sections_only():
    s = state()
    s["courses"]["7"]["layout"][0][0] = "12 October: Introduction"
    items = events.build(s, TODAY)
    sect = next(e for e in items if e["source"] == "abschnitt" and e["course_id"] == 7 and e["day"] == "2026-10-12")
    label = next(e for e in items if e["source"] == "label")
    assert (sect["title"], sect["short"]) == ("12 October: Introduction", "Introduction")
    assert label["short"] == label["title"] == "The deadline is 1 December 2026, 12 noon."


def test_build_tolerates_broken_data():
    assert events.build({}, TODAY) == []
    assert events.build({"courses": {"1": {"id": 1, "layout": [[None, []]], "cms": {"5": {"typ": "label"}}}}}, TODAY) == []


# --------------------------------------------------------------------------- Eigenschaften

MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTH_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
NOISE = st.sampled_from(["", "Session ", "Abgabe bis ", "Deadline: ", "Termin am ", "(", "Folien "])
TAIL = st.sampled_from(["", ")", ": Introduction", " | Gruppe A", ", hybrid session", " - Konferenz", "."])
VALID = st.dates(min_value=date(2026, 1, 1), max_value=date(2029, 12, 31))


def semester_for(d: date):
    """Semester, in dem das Datum nach den Regeln von resolve() liegt (WiSe ab September)."""
    return ("SoSe", d.year) if 4 <= d.month <= 8 else ("WiSe", d.year if d.month >= 9 else d.year - 1)


def formats(d: date):
    return [
        (f"{d.day} {MONTH_EN[d.month - 1]}", False),
        (f"{d.day}. {MONTH_DE[d.month - 1]}", False),
        (f"{MONTH_EN[d.month - 1]} {d.day}", False),
        (f"{d.day}th {MONTH_EN[d.month - 1][:3]}", False),
        (f"{d.day:02d}.{d.month:02d}.", False),
        (f"{d.day}.{d.month}.", False),
        (f"{d.day} {MONTH_EN[d.month - 1]} {d.year}", True),
        (f"{d.day}. {MONTH_DE[d.month - 1]} {d.year}", True),
        (f"{MONTH_EN[d.month - 1]} {d.day}, {d.year}", True),
        (f"{d.day:02d}.{d.month:02d}.{d.year}", True),
        (f"{d.day:02d}.{d.month:02d}.{d.year % 100:02d}", True),
        (d.isoformat(), True),
    ]


@settings(max_examples=300, deadline=None)
@given(VALID, NOISE, TAIL, st.integers(0, 11))
def test_every_format_round_trips(d, pre, post, i):
    text, _ = formats(d)[i]
    full = f"{pre}{text}{post}"
    hits = events.find_dates(full)
    assert len(hits) == 1, full
    assert events.resolve(hits[0], semester_for(d), date(2026, 10, 14)) == d, full


@settings(max_examples=200, deadline=None)
@given(VALID, st.integers(0, 11), VALID, st.integers(0, 11))
def test_two_dates_in_one_text_keep_their_order(a, i, b, j):
    ta, tb = formats(a)[i][0], formats(b)[j][0]
    hits = events.find_dates(f"{ta} und danach {tb}")
    assert len(hits) == 2
    assert hits[0].start < hits[1].start and hits[0].end <= hits[1].start


@settings(max_examples=300, deadline=None)
@given(VALID, NOISE, TAIL, st.integers(0, 11))
def test_clean_title_leaves_no_date_behind_and_is_stable(d, pre, post, i):
    full = f"{pre}{formats(d)[i][0]}{post}"
    c = events.clean_title(full, events.find_dates(full))
    assert events.find_dates(c) == [], (full, c)
    assert events.clean_title(c, events.find_dates(c)) == c  # nochmal bereinigen aendert nichts
    assert c == c.strip() and "  " not in c


@settings(max_examples=400, deadline=None)
@given(st.text(max_size=300))
def test_any_text_never_crashes_and_hits_are_well_formed(text):
    last = 0
    for h in events.find_dates(text):
        assert 1 <= h.day <= 31 and 1 <= h.month <= 12
        assert 0 <= h.start < h.end <= len(text) and h.start >= last
        last = h.end
        events.resolve(h, WISE, TODAY)
        events.time_after(text, h.end)


@settings(max_examples=100, deadline=None)
@given(st.lists(st.tuples(VALID, st.integers(0, 11)), max_size=6))
def test_build_is_sorted_and_ids_are_unique(items):
    titles = [formats(d)[i][0] + " Session" for d, i in items]
    s = {"courses": {"7": {"id": 7, "name": "K WiSe 2026/27", "layout": [[t, []] for t in titles], "cms": {}}}}
    out = events.build(s, TODAY)
    assert [e["ts"] for e in out] == sorted(e["ts"] for e in out)
    assert len({e["id"] for e in out}) == len(out)
