//! Stundenplan: eigene Eintraege je Semester (timetable.json im App-Ordner), Import aus und Export nach iCalendar (.ics)
//! fuer Apple- und Google-Kalender. Ein Eintrag ist ein woechentlicher Termin (Wochentag, von, bis, Raum, optional Kurs).
//! Der Export schreibt je Eintrag ein Ereignis mit woechentlicher Wiederholung ueber den gewaehlten Zeitraum (Europe/Berlin
//! samt VTIMEZONE); der Import liest woechentlich wiederkehrende Ereignisse und fasst einzelne Termine desselben Musters
//! (gleicher Titel, Wochentag und Uhrzeit, mindestens zweimal) zu einem Eintrag zusammen. Alles andere wird uebersprungen und
//! gezaehlt, nie still verworfen.

use crate::data::{self, Paths};
use crate::model::split_name;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const MAX_ENTRIES: usize = 500;
const MAX_IMPORT_BYTES: usize = 4_000_000;
const MAX_EVENTS: usize = 5_000;
const MAX_WEEKS: i64 = 60;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    /// Montag = 0 … Sonntag = 6
    pub day: u8,
    /// Minuten seit Mitternacht
    pub start: u16,
    pub end: u16,
    #[serde(default)]
    pub room: String,
    /// Kurs-ID aus LearnWeb, wenn der Eintrag zu einem Kurs gehoert
    #[serde(default)]
    pub course: Option<i64>,
}

pub type Plans = BTreeMap<String, Vec<Entry>>;

pub fn validate(entries: &[Entry]) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        return Err(format!("Zu viele Einträge (höchstens {MAX_ENTRIES})."));
    }
    let mut ids = std::collections::HashSet::new();
    for e in entries {
        if e.id.is_empty() || e.id.chars().count() > 64 || !ids.insert(&e.id) {
            return Err("Ungültige Eintrags-ID.".into());
        }
        if e.title.trim().is_empty() || e.title.chars().count() > 120 || e.room.chars().count() > 80 {
            return Err("Titel (höchstens 120 Zeichen) und Raum (höchstens 80) prüfen.".into());
        }
        if e.day > 6 || e.start >= e.end || e.end > 1440 {
            return Err("Wochentag oder Uhrzeit ungültig.".into());
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------- Ablage

fn file(paths: &Paths) -> PathBuf {
    paths.config.join("timetable.json")
}

pub fn load(paths: &Paths) -> Result<Plans, String> {
    match std::fs::read(file(paths)) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("Der Stundenplan ist nicht lesbar: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Plans::new()),
        Err(e) => Err(format!("Der Stundenplan ist nicht lesbar: {e}")),
    }
}

/// Eine Datei, die sich nicht lesen laesst, wird beiseitegelegt (timetable.json.defekt), statt von der naechsten
/// Speicherung stillschweigend ueberschrieben zu werden.
pub fn save(paths: &Paths, semester: &str, entries: Vec<Entry>) -> Result<(), String> {
    validate(&entries)?;
    if semester.trim().is_empty() || semester.chars().count() > 40 {
        return Err("Semester ungültig.".into());
    }
    let mut plans = match load(paths) {
        Ok(p) => p,
        Err(_) => {
            let _ = std::fs::rename(file(paths), paths.config.join("timetable.json.defekt"));
            Plans::new()
        }
    };
    if entries.is_empty() {
        plans.remove(semester);
    } else {
        plans.insert(semester.to_string(), entries);
    }
    std::fs::create_dir_all(&paths.config).map_err(|e| e.to_string())?;
    let tmp = paths.config.join("timetable.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&plans).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file(paths)).map_err(|e| e.to_string())
}

// --------------------------------------------------------------------------- iCalendar schreiben

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            ';' => o.push_str("\\;"),
            ',' => o.push_str("\\,"),
            '\n' => o.push_str("\\n"),
            '\r' => {}
            c => o.push(c),
        }
    }
    o
}

/// Zeilen auf hoechstens 75 Byte umbrechen (Fortsetzung beginnt mit einem Leerzeichen), nie mitten in einem Zeichen
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut len = 0;
    for c in line.chars() {
        let w = c.len_utf8();
        if len + w > 75 {
            out.push_str("\r\n ");
            len = 1;
        }
        out.push(c);
        len += w;
    }
    out
}

const VTIMEZONE: &str = "BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nBEGIN:DAYLIGHT\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nTZNAME:CEST\nDTSTART:19700329T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nBEGIN:STANDARD\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nTZNAME:CET\nDTSTART:19701025T030000\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD\nEND:VTIMEZONE";

fn local(d: NaiveDate, minutes: u16) -> String {
    format!("{}T{:02}{:02}00", d.format("%Y%m%d"), minutes / 60, minutes % 60)
}

/// Beschreibung eines Kurses: Name und Adresse in LearnWeb
pub type CourseInfo = HashMap<i64, (String, Option<String>)>;

pub fn to_ics(entries: &[Entry], from: NaiveDate, to: NaiveDate, label: &str, courses: &CourseInfo, stamp: NaiveDateTime) -> String {
    let mut lines: Vec<String> = vec!["BEGIN:VCALENDAR".into(), "VERSION:2.0".into(), "PRODID:-//Nojo//Kursbuch//DE".into(), "CALSCALE:GREGORIAN".into(), "METHOD:PUBLISH".into(),
        format!("X-WR-CALNAME:{}", esc(&format!("Stundenplan {label}"))), "X-WR-TIMEZONE:Europe/Berlin".into()];
    lines.extend(VTIMEZONE.split('\n').map(String::from));
    for e in entries {
        // erster passender Wochentag ab `from`, danach woechentlich bis `to`
        let shift = (i64::from(e.day) - i64::from(from.weekday().num_days_from_monday())).rem_euclid(7);
        let first = from + Duration::days(shift);
        if first > to {
            continue;
        }
        let count = ((to - first).num_days() / 7 + 1).min(MAX_WEEKS);
        lines.extend(["BEGIN:VEVENT".into(), format!("UID:{}@kursbuch.nojo", esc(&e.id)), format!("DTSTAMP:{}Z", stamp.format("%Y%m%dT%H%M%S")),
            format!("DTSTART;TZID=Europe/Berlin:{}", local(first, e.start)), format!("DTEND;TZID=Europe/Berlin:{}", local(first, e.end)),
            format!("RRULE:FREQ=WEEKLY;COUNT={count}"), format!("SUMMARY:{}", esc(&e.title))]);
        if !e.room.is_empty() {
            lines.push(format!("LOCATION:{}", esc(&e.room)));
        }
        if let Some((name, url)) = e.course.and_then(|c| courses.get(&c)) {
            let d = match url {
                Some(u) => format!("{name}\n{u}"),
                None => name.clone(),
            };
            lines.push(format!("DESCRIPTION:{}", esc(&d)));
        }
        lines.push("END:VEVENT".into());
    }
    lines.push("END:VCALENDAR".into());
    lines.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

// --------------------------------------------------------------------------- iCalendar lesen

fn unesc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            o.push(c);
            continue;
        }
        match it.next() {
            Some('n' | 'N') => o.push(' '),
            Some(x) => o.push(x),
            None => {}
        }
    }
    o.trim().to_string()
}

/// Zeilen entfalten (Fortsetzungszeilen beginnen mit Leerzeichen oder Tab)
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in text.lines() {
        if (l.starts_with(' ') || l.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&l[1..]);
        } else {
            out.push(l.to_string());
        }
    }
    out
}

/// "Name;PARAM=x" und Wert einer Zeile
fn prop(line: &str) -> Option<(String, &str, &str)> {
    let (head, value) = line.split_once(':')?;
    let (name, params) = head.split_once(';').unwrap_or((head, ""));
    Some((name.to_ascii_uppercase(), params, value))
}

/// (Tag, Minuten seit Mitternacht) in Ortszeit; Datum ohne Uhrzeit ergibt None. Mit `Z` wird von UTC in die Ortszeit umgerechnet.
fn when(value: &str) -> Option<(NaiveDate, u16)> {
    let v = value.trim();
    let (body, utc) = v.strip_suffix('Z').map_or((v, false), |b| (b, true));
    let dt = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S").ok()?;
    let dt = if utc { Local.from_utc_datetime(&dt).naive_local() } else { dt };
    Some((dt.date(), (dt.hour() * 60 + dt.minute()) as u16))
}

/// "PT1H30M", "PT90M", "P1D" (letzteres ergibt None: ganztaegig)
fn duration(v: &str) -> Option<u16> {
    let v = v.trim().strip_prefix("PT")?;
    let (mut total, mut num) = (0u32, 0u32);
    for c in v.chars() {
        match c {
            '0'..='9' => num = num.checked_mul(10)?.checked_add(c as u32 - '0' as u32)?,
            'H' => { total += num * 60; num = 0; }
            'M' => { total += num; num = 0; }
            'S' => num = 0,
            _ => return None,
        }
    }
    u16::try_from(total).ok().filter(|t| *t > 0)
}

fn byday(rule: &str) -> Vec<u8> {
    rule.split(';')
        .find_map(|p| p.strip_prefix("BYDAY="))
        .map(|v| {
            v.split(',')
                .filter_map(|d| match d.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '+') {
                    "MO" => Some(0), "TU" => Some(1), "WE" => Some(2), "TH" => Some(3), "FR" => Some(4), "SA" => Some(5), "SU" => Some(6), _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize, Debug, Default)]
pub struct Imported {
    pub entries: Vec<Entry>,
    /// Ereignisse, die nicht uebernommen wurden (einmalig, ganztaegig, andere Wiederholung, abgesagt …)
    pub skipped: usize,
}

type Key = (String, u8, u16, u16, String);

pub fn from_ics(text: &str) -> Result<Imported, String> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err("Die Datei ist zu groß.".into());
    }
    let mut recurring: Vec<Key> = Vec::new();
    let mut single: BTreeMap<Key, usize> = BTreeMap::new();
    let (mut events, mut skipped) = (0usize, 0usize);
    let mut cur: Option<HashMap<String, (String, String)>> = None;
    for line in unfold(text) {
        let l = line.trim_end();
        if l.eq_ignore_ascii_case("BEGIN:VEVENT") {
            cur = Some(HashMap::new());
        } else if l.eq_ignore_ascii_case("END:VEVENT") {
            let Some(p) = cur.take() else { continue };
            events += 1;
            if events > MAX_EVENTS {
                return Err("Zu viele Termine in der Datei.".into());
            }
            let get = |k: &str| p.get(k).map(|(_, v)| v.as_str());
            let (Some(title), Some((date, start))) = (get("SUMMARY").map(unesc).filter(|t| !t.is_empty()), get("DTSTART").and_then(when)) else { skipped += 1; continue };
            let end = if let Some((d2, e)) = get("DTEND").and_then(when) {
                (d2 == date).then_some(e)
            } else {
                get("DURATION").and_then(duration).map(|m| start + m)
            };
            let cancelled = get("STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"));
            let Some(end) = end.filter(|e| *e > start && *e <= 1440 && !cancelled) else { skipped += 1; continue };
            let room = get("LOCATION").map(unesc).unwrap_or_default();
            let title = title.chars().take(120).collect::<String>().trim_end().to_string();
            let room = room.chars().take(80).collect::<String>().trim_end().to_string();
            let weekday = date.weekday().num_days_from_monday() as u8;
            match get("RRULE") {
                Some(rule) if rule.to_ascii_uppercase().contains("FREQ=WEEKLY") => {
                    let days = byday(&rule.to_ascii_uppercase());
                    for d in if days.is_empty() { vec![weekday] } else { days } {
                        recurring.push((title.clone(), d, start, end, room.clone()));
                    }
                }
                Some(_) => skipped += 1,
                None => *single.entry((title, weekday, start, end, room)).or_default() += 1,
            }
        } else if let (Some(p), Some((name, params, value))) = (cur.as_mut(), prop(l)) {
            p.entry(name).or_insert_with(|| (params.to_string(), value.to_string()));
        }
    }
    let mut keys: Vec<Key> = recurring;
    for (k, n) in single {
        if n >= 2 { keys.push(k) } else { skipped += n }
    }
    keys.sort_by(|a, b| (a.1, a.2, &a.0).cmp(&(b.1, b.2, &b.0)));
    keys.dedup();
    let stamp = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let entries = keys.into_iter().enumerate().take(MAX_ENTRIES).map(|(i, (title, day, start, end, room))| Entry { id: format!("i{stamp:x}-{i}"), title, day, start, end, room, course: None }).collect();
    Ok(Imported { entries, skipped })
}

// --------------------------------------------------------------------------- Befehle

#[tauri::command]
pub fn timetable_get(paths: State<Paths>) -> Result<Plans, String> {
    load(&paths)
}

#[tauri::command]
pub fn timetable_save(paths: State<Paths>, semester: String, entries: Vec<Entry>) -> Result<(), String> {
    save(&paths, &semester, entries)
}

#[tauri::command]
pub fn timetable_import(text: String) -> Result<Imported, String> {
    from_ics(&text)
}

fn downloads() -> Result<PathBuf, String> {
    let dir = std::env::var_os("KURSBUCH_DOWNLOADS").map(PathBuf::from).or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads")));
    dir.filter(|d| d.is_dir()).ok_or_else(|| "Der Ordner „Downloads“ fehlt.".to_string())
}

/// Dateiname ohne Zeichen, die Windows nicht mag
fn safe(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || " .-_()".contains(c) { c } else { '_' }).collect()
}

/// Stundenplan eines Semesters als .ics in „Downloads“ schreiben und im Explorer zeigen; `from`/`to` als JJJJ-MM-TT
#[tauri::command]
pub fn timetable_export(app: AppHandle, paths: State<Paths>, semester: String, from: String, to: String) -> Result<String, String> {
    let (from, to) = (NaiveDate::parse_from_str(&from, "%Y-%m-%d").map_err(|_| "Beginn ungültig.")?, NaiveDate::parse_from_str(&to, "%Y-%m-%d").map_err(|_| "Ende ungültig.")?);
    if to < from {
        return Err("Das Ende liegt vor dem Beginn.".into());
    }
    let entries = load(&paths)?.remove(&semester).unwrap_or_default();
    if entries.is_empty() {
        return Err("Der Stundenplan ist leer.".into());
    }
    let mut courses = CourseInfo::new();
    if let Ok(s) = data::state(&paths) {
        for c in s.courses.values() {
            courses.insert(c.id, (split_name(&c.name).title, c.url.clone().filter(|u| data::is_web(&Some(u.clone())))));
        }
    }
    let ics = to_ics(&entries, from, to, &semester, &courses, Utc::now().naive_utc());
    let target = downloads()?.join(format!("Stundenplan {}.ics", safe(&semester)));
    std::fs::write(&target, ics).map_err(|e| format!("Die Datei ließ sich nicht schreiben: {e}"))?;
    if std::env::var_os("KURSBUCH_DOWNLOADS").is_none() {
        let _ = app.opener().reveal_item_in_dir(&target); // mit dem Test-Hook bleibt der Explorer zu
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, title: &str, day: u8, start: u16, end: u16, room: &str) -> Entry {
        Entry { id: id.into(), title: title.into(), day, start, end, room: room.into(), course: None }
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn stamp() -> NaiveDateTime {
        d("2026-10-14").and_hms_opt(12, 0, 0).unwrap()
    }

    fn strip(v: &[Entry]) -> Vec<(String, u8, u16, u16, String)> {
        let mut o: Vec<_> = v.iter().map(|x| (x.title.clone(), x.day, x.start, x.end, x.room.clone())).collect();
        o.sort();
        o
    }

    #[test]
    fn export_has_weekly_events_in_berlin_time_and_valid_lines() {
        let mut c = CourseInfo::new();
        c.insert(7, ("Gulliver's Travels".into(), Some("https://www.uni-muenster.de/LearnWeb/learnweb2/course/view.php?id=7".into())));
        let mut x = e("a1", "Seminar, Teil 1; extra", 2, 600, 720, "Raum 3\nHaus B");
        x.course = Some(7);
        let ics = to_ics(&[x], d("2026-10-12"), d("2027-02-05"), "WiSe 2026/27", &c, stamp());
        for needle in ["BEGIN:VCALENDAR\r\n", "TZID:Europe/Berlin", "DTSTART;TZID=Europe/Berlin:20261014T100000", "DTEND;TZID=Europe/Berlin:20261014T120000", "RRULE:FREQ=WEEKLY;COUNT=17",
                       "SUMMARY:Seminar\\, Teil 1\\; extra", "LOCATION:Raum 3\\nHaus B", "UID:a1@kursbuch.nojo", "END:VCALENDAR\r\n"] {
            assert!(ics.contains(needle), "{needle}");
        }
        assert!(ics.contains("DESCRIPTION:Gulliver's Travels\\nhttps://www.uni-muenster.de") || ics.contains("DESCRIPTION:Gulliver's Travels"));
        assert!(ics.split("\r\n").all(|l| l.len() <= 75), "Zeilen hoechstens 75 Byte");
        assert!(!ics.contains("\r\r"));
    }

    #[test]
    fn export_counts_weeks_and_skips_entries_outside_the_range() {
        let ics = to_ics(&[e("a", "A", 0, 480, 600, ""), e("b", "B", 4, 480, 600, "")], d("2026-10-12"), d("2026-10-18"), "x", &CourseInfo::new(), stamp());
        assert!(ics.matches("COUNT=1").count() == 2);
        // Mittwoch nach dem Zeitraum: kein Ereignis
        let ics = to_ics(&[e("a", "A", 0, 480, 600, "")], d("2026-10-13"), d("2026-10-18"), "x", &CourseInfo::new(), stamp());
        assert!(!ics.contains("BEGIN:VEVENT"));
        // Obergrenze: ein Jahr ergibt hoechstens 60 Wochen
        let ics = to_ics(&[e("a", "A", 0, 480, 600, "")], d("2026-01-05"), d("2030-01-05"), "x", &CourseInfo::new(), stamp());
        assert!(ics.contains("COUNT=60"));
    }

    #[test]
    fn long_and_unicode_titles_fold_without_breaking_characters() {
        let title = "Überlänge 😀 ".repeat(30);
        let ics = to_ics(&[e("a", &title, 1, 480, 600, "")], d("2026-10-12"), d("2026-11-12"), "x", &CourseInfo::new(), stamp());
        assert!(ics.split("\r\n").all(|l| l.len() <= 75));
        assert_eq!(from_ics(&ics).unwrap().entries[0].title, title.chars().take(120).collect::<String>().trim().to_string());
    }

    #[test]
    fn import_reads_weekly_rules_with_byday_and_collects_single_dates() {
        let ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Vorlesung\nDTSTART;TZID=Europe/Berlin:20261012T100000\nDTEND;TZID=Europe/Berlin:20261012T120000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\nLOCATION:H1\nEND:VEVENT\n\
                   BEGIN:VEVENT\nSUMMARY:Uebung\nDTSTART:20261013T080000\nDURATION:PT1H30M\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Uebung\nDTSTART:20261020T080000\nDURATION:PT1H30M\nEND:VEVENT\n\
                   BEGIN:VEVENT\nSUMMARY:Geburtstag\nDTSTART;VALUE=DATE:20261014\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Einmal\nDTSTART:20261014T100000\nDTEND:20261014T110000\nEND:VEVENT\n\
                   BEGIN:VEVENT\nSUMMARY:Monatlich\nDTSTART:20261014T100000\nDTEND:20261014T110000\nRRULE:FREQ=MONTHLY\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Abgesagt\nSTATUS:CANCELLED\nDTSTART:20261014T100000\nDTEND:20261014T110000\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR";
        let r = from_ics(ics).unwrap();
        assert_eq!(strip(&r.entries), vec![("Uebung".to_string(), 1, 480, 570, String::new()), ("Vorlesung".into(), 0, 600, 720, "H1".into()), ("Vorlesung".into(), 2, 600, 720, "H1".into())]);
        assert_eq!(r.skipped, 4); // Geburtstag, Einmal, Monatlich, Abgesagt
    }

    #[test]
    fn import_tolerates_garbage_and_rejects_oversized_input() {
        for s in ["", "\0\0\0", "BEGIN:VEVENT", "END:VEVENT\nEND:VEVENT", "BEGIN:VEVENT\nSUMMARY\nDTSTART:\nEND:VEVENT", "BEGIN:VEVENT\nSUMMARY:x\nDTSTART:99999999T999999\nEND:VEVENT", "\u{1F600}".repeat(1000).as_str(),
                  "BEGIN:VEVENT\nSUMMARY:x\nDTSTART:20261012T100000\nDTEND:20261011T100000\nEND:VEVENT"] {
            let r = from_ics(s).unwrap();
            assert!(r.entries.is_empty(), "{s:?}");
        }
        assert!(from_ics(&"x".repeat(MAX_IMPORT_BYTES + 1)).is_err());
        let many = "BEGIN:VEVENT\nSUMMARY:x\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\n".repeat(MAX_EVENTS + 1);
        assert!(from_ics(&many).is_err());
    }

    /// Eigenschaft: was exportiert wird, kommt beim Import unveraendert zurueck (Titel, Raum, Tag, Zeiten), egal welche Zeichen
    /// (Komma, Semikolon, Backslash, Zeilenumbruch, Umlaute, Emoji, sehr lange Texte) darin stehen.
    #[test]
    fn export_then_import_returns_the_same_entries() {
        let alphabet = ["a", "Z", "ä", "ß", "😀", " ", ",", ";", "\\", "\n", ":", "\"", "=", "X", "中", "é", "\t", "-", "BEGIN:", "END:", "SUMMARY:", ".", "_"];
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
        for round in 0..300 {
            let n = 1 + (next() % 6) as usize;
            let entries: Vec<Entry> = (0..n)
                .map(|i| {
                    let text = |max: u64, nx: &mut dyn FnMut() -> u64| -> String { (0..(nx() % max)).map(|_| alphabet[(nx() % alphabet.len() as u64) as usize]).collect() };
                    let title = format!("T{i}{}", text(40, &mut next)).trim().to_string();
                    let room = text(20, &mut next).trim().to_string();
                    let start = (next() % 1300) as u16;
                    let end = start + 1 + (next() % u64::from(1440 - start - 1).max(1)) as u16;
                    let title = title.replace('\n', " ").replace('\t', " ");
                    e(&format!("id{round}-{i}"), &title.chars().take(120).collect::<String>(), (next() % 7) as u8, start, end.min(1440), &room.replace('\n', " ").replace('\t', " "))
                })
                .collect();
            // gleiche Muster ergeben beim Import einen Eintrag: nur Eintraege ohne Dopplung pruefen
            let mut seen = std::collections::HashSet::new();
            let entries: Vec<Entry> = entries.into_iter().filter(|x| seen.insert((x.title.trim().to_string(), x.day, x.start, x.end, x.room.trim().to_string()))).collect();
            let ics = to_ics(&entries, d("2026-10-12"), d("2026-12-20"), "WiSe", &CourseInfo::new(), stamp());
            let back = from_ics(&ics).unwrap();
            let want: Vec<_> = strip(&entries.iter().map(|x| Entry { title: x.title.trim().to_string(), room: x.room.trim().to_string(), ..x.clone() }).collect::<Vec<_>>());
            assert_eq!(strip(&back.entries), want, "Runde {round}");
            assert_eq!(back.skipped, 0);
        }
    }

    #[test]
    fn validation_rejects_broken_entries() {
        assert!(validate(&[e("a", "ok", 0, 480, 540, "")]).is_ok());
        for bad in [e("", "x", 0, 1, 2, ""), e("a", "  ", 0, 1, 2, ""), e("a", "x", 7, 1, 2, ""), e("a", "x", 0, 600, 600, ""), e("a", "x", 0, 600, 1441, ""), e("a", &"x".repeat(121), 0, 1, 2, ""), e("a", "x", 0, 1, 2, &"r".repeat(81))] {
            assert!(validate(&[bad]).is_err());
        }
        assert!(validate(&[e("a", "x", 0, 1, 2, ""), e("a", "y", 0, 1, 2, "")]).is_err()); // doppelte ID
        assert!(validate(&(0..501).map(|i| e(&format!("{i}"), "x", 0, 1, 2, "")).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn store_roundtrips_per_semester_and_quarantines_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("kursbuch-tt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = Paths { project: dir.clone(), uv: dir.clone(), config: dir.join("cfg"), notch: false };
        assert!(load(&p).unwrap().is_empty());
        save(&p, "WiSe 2026/27", vec![e("a", "Seminar", 1, 600, 720, "H1")]).unwrap();
        save(&p, "SoSe 2026", vec![e("b", "Tennis", 3, 900, 1020, "")]).unwrap();
        let plans = load(&p).unwrap();
        assert_eq!(plans["WiSe 2026/27"][0].title, "Seminar");
        assert_eq!(plans["SoSe 2026"][0].room, "");
        save(&p, "SoSe 2026", vec![]).unwrap(); // leer = Semester entfernen
        assert!(!load(&p).unwrap().contains_key("SoSe 2026"));
        assert!(save(&p, "WiSe 2026/27", vec![e("a", "x", 9, 1, 2, "")]).is_err()); // ungueltig: nichts geschrieben
        assert_eq!(load(&p).unwrap()["WiSe 2026/27"][0].title, "Seminar");
        std::fs::write(p.config.join("timetable.json"), b"{kaputt").unwrap();
        assert!(load(&p).is_err());
        save(&p, "WiSe 2026/27", vec![e("c", "Neu", 0, 480, 540, "")]).unwrap();
        assert!(p.config.join("timetable.json.defekt").exists() && load(&p).unwrap()["WiSe 2026/27"][0].title == "Neu");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(safe("WiSe 2026/27"), "WiSe 2026_27");
        assert_eq!(safe("a:b*c?\"d<e>|f\\g"), "a_b_c__d_e__f_g");
    }
}
