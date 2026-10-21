"""Regeltermine von Seminaren und Vorlesungen automatisch erkennen (data/schedule.json), ohne Netz und ohne KI.

    uv run python -m learnweb.cli schedule        # aus State, Terminen und Inhalten neu berechnen (der Sync tut es nach den Terminen)

Quellen (alles schon lokal vorhanden):
- Wochentag: die Sitzungstermine aus den Abschnittstiteln und Labels („13.04. - Alltagswissen“, siehe events.py). Liegen mindestens
  zwei im Wochenabstand auf demselben Wochentag, ist das der Regeltermin; je mehr, desto sicherer.
- Uhrzeit und Raum: steht sie in LearnWeb (Abschnittstitel, Labels, Ankuendigungen, Aufgabenbeschreibungen, Kursname) neben dem
  Wochentag („montags 10-12 Uhr“, „Di 14 c.t.“, „Thursdays 2-4 pm“), wird sie uebernommen; Sprechstunden, Abgaben, Klausuren und
  einmalige Termine zaehlen nicht. Oft steht sie dort aber nicht: dann bleibt die Uhrzeit offen und die App fragt danach.
Jeder Fund nennt seine Quelle und Sicherheit; die App zeigt sie dem Nutzer und legt sie nur mit Uhrzeit von selbst an.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter

# Montag = 0
DAYS = {
    0: r"mo(?:ntag(?:s)?|n)?|mon(?:day(?:s)?)?",
    1: r"di(?:enstag(?:s)?|e)?|tue(?:s(?:day(?:s)?)?)?",
    2: r"mi(?:ttwoch(?:s)?|tt)?|wed(?:nesday(?:s)?)?",
    3: r"do(?:nnerstag(?:s)?|nn)?|thu(?:r(?:s(?:day(?:s)?)?)?)?",
    4: r"fr(?:eitag(?:s)?|ei)?|fri(?:day(?:s)?)?",
    5: r"sa(?:mstag(?:s)?|m)?|sat(?:urday(?:s)?)?",
    6: r"so(?:nntag(?:s)?|nn)?|sun(?:day(?:s)?)?",
}
DAY_RE = {d: re.compile(rf"(?<![A-Za-zäöüÄÖÜ])(?:{p})\.?(?![A-Za-zäöüÄÖÜ])", re.I) for d, p in DAYS.items()}
# Zeitraum: 10-12, 10:15-11:45, 10 bis 12 Uhr, 10.00 - 12.00, 2-4 pm, optional „Uhr“/„h“/„am“/„pm“
RANGE = re.compile(r"(?<!\d)(\d{1,2})(?:[:.](\d{2}))?\s*(?:Uhr|h|am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|bis|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(Uhr|h|am|pm|a\.m\.|p\.m\.)?(?!\d)", re.I)
CT = re.compile(r"(?<!\d)(\d{1,2})\s*(c\.?\s?t\.?|s\.?\s?t\.?)(?![A-Za-z])", re.I)
ROOM = re.compile(r"\b(?:Raum|Room|Hörsaal|Hoersaal|Seminarraum|HS)\s*[:.]?\s*([A-ZÄÖÜ]{0,3}\s?\d{1,4}[A-Za-z]?(?:[ -/.]\d{1,3})?|[A-ZÄÖÜ][A-Za-zäöüß-]{2,24})")
# Kontexte, in denen eine Uhrzeit kein Regeltermin ist
NOT_A_SLOT = re.compile(r"sprechstunde|office\s*hour|sprechzeit|abgabe|frist|deadline|due|klausur|prüfung|pruefung|exam|nachhol|zoom|meeting-id|anmeld|bewerb|wahlverfahren", re.I)


def _minutes(h: int, m: int | None, ampm: str | None) -> int | None:
    h = int(h)
    m = int(m or 0)
    a = (ampm or "").lower().replace(".", "")
    if a == "pm" and h < 12:
        h += 12
    if a == "am" and h == 12:
        h = 0
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def parse_range(text: str) -> tuple[int, int] | None:
    """Erster plausibler Zeitraum eines Textes als (Beginn, Ende) in Minuten; None, wenn keiner dasteht. Nie eine Ausnahme."""
    for m in RANGE.finditer(text or ""):
        h1, m1, h2, m2, tail = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        ampm_end = tail if tail and tail.lower().replace(".", "") in ("am", "pm") else None
        a = _minutes(h1, m1, ampm_end)
        b = _minutes(h2, m2, ampm_end)
        if a is None or b is None:
            continue
        # „2-4 pm“: der Beginn teilt das pm; „10-12“ ohne Angabe bleibt, wie es steht
        if ampm_end == "pm" and a >= b and a >= 12 * 60:
            a -= 12 * 60
        if 6 * 60 <= a < b <= 22 * 60 and 45 <= b - a <= 4 * 60:
            return a, b
    c = CT.search(text or "")
    if c:
        h = int(c.group(1))
        start = h * 60 + (15 if c.group(2).lower().replace(".", "").replace(" ", "").startswith("c") else 0)
        if 6 <= h <= 20:
            return start, start + 90  # Universitaets-Doppelstunde: 90 Minuten
    return None


def find_slot(text: str, weekday: int) -> tuple[int, int, str | None] | None:
    """Uhrzeit (und Raum) zu einem Wochentag aus einem Text: Wochentagswort und Zeitraum dicht beieinander, kein Sprechstunden-Kontext."""
    if not text:
        return None
    for dm in DAY_RE[weekday].finditer(text):
        window = text[max(0, dm.start() - 12): dm.end() + 40]
        ctx = text[max(0, dm.start() - 40): dm.end() + 60]
        if NOT_A_SLOT.search(ctx):
            continue
        r = parse_range(window)
        if r:
            room = ROOM.search(text[max(0, dm.start() - 40): dm.end() + 80])
            return r[0], r[1], (room.group(1).strip() if room else None)
    return None


def weekly_slots(sessions: list[dict]) -> list[dict]:
    """Sitzungstermine eines Kurses -> Regeltermine [{weekday, count, first, last}] (mindestens zwei, ueberwiegend im Wochenabstand)"""
    days = sorted({dt.date.fromisoformat(s["day"]) for s in sessions if s.get("day")})
    if len(days) < 2:
        return []
    by = Counter(d.weekday() for d in days)
    out = []
    for wd, n in by.most_common():
        mine = [d for d in days if d.weekday() == wd]
        if n < 2 or n < 0.34 * len(days):
            continue
        gaps = [(b - a).days for a, b in zip(mine, mine[1:])]
        weekly = sum(1 for g in gaps if g % 7 == 0 and g <= 21) >= max(1, len(gaps) // 2)
        if weekly:
            out.append({"weekday": wd, "count": n, "first": mine[0].isoformat(), "last": mine[-1].isoformat()})
    return out


def _texts(entry: dict, extra: dict) -> list[tuple[str, str]]:
    t = [("Kursname", entry.get("name", ""))]
    t += [("Abschnitt", title) for title, _ in entry.get("layout", [])]
    t += [("Text im Kurs", cm.get("name", "")) for cm in entry.get("cms", {}).values() if cm.get("typ") == "label"]
    t += [("Ankündigung", f"{n.get('title', '')}. {n.get('text', '')}") for n in extra.get("news", [])]
    t += [("Aufgabe", a.get("intro", "")) for a in extra.get("assignments", [])]
    return t


def detect(state: dict, events: list[dict], content: dict | None = None) -> list[dict]:
    """Alle erkannten Regeltermine ueber alle Kurse; stabil sortiert (Kurs, Wochentag)"""
    items = []
    by_course: dict[int, list[dict]] = {}
    for e in events:
        if e.get("kind") == "sitzung" and e.get("course_id") is not None:
            by_course.setdefault(e["course_id"], []).append(e)
    for cid_s, entry in state.get("courses", {}).items():
        cid = int(cid_s)
        slots = weekly_slots(by_course.get(cid, []))
        extra = ((content or {}).get("courses") or {}).get(cid_s, {})
        texts = _texts(entry, extra)
        for sl in slots:
            found = next(((f, src) for src, t in texts if (f := find_slot(t, sl["weekday"]))), None)
            n = sl["count"]
            sure = "hoch" if n >= 6 else "mittel" if n >= 3 else "niedrig"
            item = {"course_id": cid, "weekday": sl["weekday"], "start": None, "end": None, "room": None, "confidence": sure,
                    "sessions": n, "first": sl["first"], "last": sl["last"],
                    "source": f"{n} Sitzungstermine am {['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'][sl['weekday']]}"}
            if found:
                (a, b, room), src = found
                item.update(start=a, end=b, room=room, source=item["source"] + f"; Uhrzeit aus: {src}")
            items.append(item)
    return sorted(items, key=lambda i: (i["course_id"], i["weekday"]))


def update(state: dict, events: list[dict], content: dict | None, save, now: int) -> dict:
    items = detect(state, events, content)
    save({"updated": now, "items": items})
    return {"count": len(items), "with_time": sum(1 for i in items if i["start"] is not None)}
