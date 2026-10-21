"""Regeltermine erkennen (schedule.py) und die automatische Kursauswahl (sync.auto_since)."""
import time

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from learnweb import cli, schedule, sync


def sess(*days):
    return [{"kind": "sitzung", "course_id": 7, "day": d} for d in days]


# --------------------------------------------------------------------------- Wochentag aus den Sitzungen

def test_weekly_slots_need_two_dates_in_a_weekly_rhythm_on_the_same_weekday():
    mondays = [f"2026-04-{d}" for d in ("13", "20", "27")] + ["2026-05-04", "2026-05-11"]
    assert schedule.weekly_slots(sess(*mondays)) == [{"weekday": 0, "count": 5, "first": "2026-04-13", "last": "2026-05-11"}]
    assert schedule.weekly_slots(sess("2026-04-13")) == []  # eine Sitzung ist kein Rhythmus
    assert schedule.weekly_slots(sess("2026-04-13", "2026-04-15", "2026-04-17")) == []  # jeder Tag nur einmal
    assert schedule.weekly_slots(sess("2026-04-13", "2026-04-20"))[0]["weekday"] == 0
    assert schedule.weekly_slots(sess("2026-04-13", "2026-04-27", "2026-05-11"))[0]["count"] == 3  # alle zwei Wochen zaehlt auch
    assert schedule.weekly_slots([]) == [] and schedule.weekly_slots([{"kind": "sitzung", "course_id": 1}]) == []
    # zwei Wochentage mit je mehreren Sitzungen (Vorlesung und Uebung)
    two = schedule.weekly_slots(sess("2026-04-13", "2026-04-20", "2026-04-27", "2026-04-16", "2026-04-23", "2026-04-30"))
    assert sorted(s["weekday"] for s in two) == [0, 3]
    # ein einzelner Ausreisser am anderen Wochentag stoert nicht
    assert [s["weekday"] for s in schedule.weekly_slots(sess("2026-04-13", "2026-04-20", "2026-04-27", "2026-05-04", "2026-05-12"))] == [0]


# --------------------------------------------------------------------------- Uhrzeit aus Texten

@pytest.mark.parametrize("text, expected", [
    ("montags 10-12 Uhr", (600, 720)),
    ("Mo 10:15–11:45", (615, 705)),
    ("Montag, 14.00 bis 16.00 Uhr im Hörsaal", (840, 960)),
    ("Mondays from 2-4 pm", (840, 960)),
    ("Monday 9 am to 11 am", (540, 660)),
    ("Montags 14 c.t.", (855, 945)),
    ("Mo 12 s.t.", (720, 810)),
    ("Wednesday 10 - 12 in room S 204", None),   # anderer Wochentag
    ("Montag 7-23", None),                        # unplausibel (zu lang, zu spaet)
    ("Montag 11-12", (660, 720)),                 # eine Stunde reicht
    ("Montag 11:00-11:15", None),                 # zu kurz fuer eine Lehrveranstaltung
    ("Sprechstunde montags 10-12 Uhr", None),     # keine Lehrveranstaltung
    ("Abgabe bis Montag 10-12 Uhr", None),
    ("", None),
])
def test_find_slot_reads_weekday_times_and_refuses_office_hours(text, expected):
    got = schedule.find_slot(text, 0)
    assert (got[:2] if got else None) == expected


def test_find_slot_picks_up_the_room_next_to_it():
    assert schedule.find_slot("Dienstags 14-16 Uhr, Raum S 204", 1) == (840, 960, "S 204")
    assert schedule.find_slot("Do 10-12 Hörsaal H1", 3)[2] == "H1"
    assert schedule.find_slot("Do 10-12", 3)[2] is None


@settings(max_examples=400, deadline=None)
@given(st.text(max_size=80))
def test_parse_range_never_raises_and_returns_a_plausible_lecture_slot(text):
    r = schedule.parse_range(text)
    assert r is None or (6 * 60 <= r[0] < r[1] <= 22 * 60 + 90 and r[1] - r[0] >= 30)
    schedule.find_slot(text, 2)


# --------------------------------------------------------------------------- alles zusammen

def test_detect_combines_sessions_with_a_time_found_in_course_texts():
    state = {"courses": {
        "7": {"id": 7, "name": "VL Sportpsychologie", "layout": [["13.04. Einführung", []]], "cms": {"1": {"typ": "label", "name": "Die Vorlesung findet montags 10-12 Uhr statt (Raum H 4).", "section": "x"}}},
        "8": {"id": 8, "name": "Seminar ohne Uhrzeit", "layout": [], "cms": {}},
        "9": {"id": 9, "name": "Kein Rhythmus", "layout": [], "cms": {}}}}
    events = ([{"kind": "sitzung", "course_id": 7, "day": d} for d in ("2026-04-13", "2026-04-20", "2026-04-27", "2026-05-04", "2026-05-11", "2026-05-18")]
              + [{"kind": "sitzung", "course_id": 8, "day": d} for d in ("2026-04-16", "2026-04-23", "2026-04-30")]
              + [{"kind": "sitzung", "course_id": 9, "day": "2026-04-16"}, {"kind": "frist", "course_id": 9, "day": "2026-04-17"}])
    a, b = schedule.detect(state, events)
    assert (a["course_id"], a["weekday"], a["start"], a["end"], a["room"], a["confidence"]) == (7, 0, 600, 720, "H 4", "hoch")
    assert "Uhrzeit aus: Text im Kurs" in a["source"] and a["sessions"] == 6
    assert (b["course_id"], b["weekday"], b["start"], b["confidence"]) == (8, 3, None, "mittel") and "Donnerstag" in b["source"]
    # eine Ankündigung liefert die Uhrzeit, wenn sonst nichts da ist
    content = {"courses": {"8": {"news": [{"title": "Start", "text": "Wir treffen uns donnerstags von 14 bis 16 Uhr."}]}}}
    assert schedule.detect(state, events, content)[1]["start"] == 840
    assert schedule.detect({"courses": {}}, []) == []


def test_update_saves_and_counts():
    saved = []
    state = {"courses": {"7": {"id": 7, "name": "x", "layout": [], "cms": {}}}}
    events = [{"kind": "sitzung", "course_id": 7, "day": d} for d in ("2026-04-13", "2026-04-20")]
    assert schedule.update(state, events, None, saved.append, 5) == {"count": 1, "with_time": 0}
    assert saved[0]["updated"] == 5 and saved[0]["items"][0]["weekday"] == 0


def test_cli_schedule_needs_a_state_and_writes_the_file(tmp_path, capsys):
    assert cli.main(["schedule"]) == 1
    capsys.readouterr()
    sync.save_json(sync.STATE, {"courses": {"7": {"id": 7, "name": "x", "layout": [], "cms": {}}}})
    sync.save_json(sync.EVENTS, {"items": [{"kind": "sitzung", "course_id": 7, "day": d} for d in ("2026-04-13", "2026-04-20")]})
    assert cli.main(["schedule"]) == 0
    assert sync.load_json(sync.SCHEDULE, {})["items"][0]["course_id"] == 7


# --------------------------------------------------------------------------- automatische Kursauswahl

@pytest.mark.parametrize("today, expected", [
    ((2026, 10, 14), "2026-03-01"), ((2026, 12, 31), "2026-03-01"), ((2027, 1, 5), "2026-03-01"), ((2027, 3, 31), "2026-03-01"),
    ((2027, 4, 1), "2026-09-01"), ((2027, 9, 30), "2026-09-01"), ((2027, 10, 1), "2027-03-01"), ((2026, 4, 1), "2025-09-01"),
])
def test_auto_since_starts_one_month_before_the_previous_semester(today, expected):
    assert sync.auto_since(time.struct_time((*today, 0, 0, 0, 0, 0, -1))) == expected


def test_default_config_selects_courses_automatically_and_an_explicit_date_still_wins():
    assert sync.DEFAULT_CONFIG["kurse_ab"] == "auto"

    class LW:
        def ajax(self, method, args):
            return {"courses": [{"id": 1, "fullname": "Alt", "startdate": int(time.mktime((2020, 1, 1, 0, 0, 0, 0, 0, -1)))},
                                {"id": 2, "fullname": "Neu", "startdate": int(time.time()) - 86400}]}

    assert [c["id"] for c in sync.select_courses(LW(), {**sync.DEFAULT_CONFIG, "kurse_extra": [], "kurse_aus": []})] == [2]
    assert [c["id"] for c in sync.select_courses(LW(), {**sync.DEFAULT_CONFIG, "kurse_ab": "2019-01-01", "kurse_extra": [], "kurse_aus": []})] == [1, 2]
