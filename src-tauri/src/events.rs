//! Termine fuer Zeitstrahl, Kalender und Notch: LearnWeb-Fristen (data/deadlines.json, `core_calendar_get_action_events`)
//! und die Termine aus Abschnittstiteln und Labels (data/events.json, Parser in learnweb-mcp/learnweb/events.py).
//! Steht eine Frist in beiden Quellen (gleicher Kurs, gleicher Tag), gilt die von LearnWeb.

use crate::data::Paths;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize, Default)]
struct DlFile {
    #[serde(default)]
    items: Vec<Dl>,
}

#[derive(Deserialize)]
struct Dl {
    ts: Option<i64>,
    /// "2026-10-18 23:55" (Ortszeit)
    #[serde(default)]
    faellig: String,
    #[serde(default)]
    ueberfaellig: bool,
    #[serde(default)]
    titel: String,
    #[serde(default)]
    typ: Option<String>,
    kurs_id: Option<i64>,
}

#[derive(Deserialize, Default)]
struct EvFile {
    #[serde(default)]
    items: Vec<Ev>,
}

#[derive(Deserialize)]
struct Ev {
    id: String,
    ts: i64,
    #[serde(default)]
    day: String,
    #[serde(default)]
    all_day: bool,
    kind: String,
    title: String,
    /// Titel ohne Datum (aeltere events.json haben ihn nicht)
    #[serde(default)]
    short: String,
    course_id: Option<i64>,
    #[serde(default)]
    source: String,
}

/// Ein Termin, wie ihn die Oberflaeche bekommt. kind: sitzung | frist | pruefung | termin
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub ts: i64,
    pub all_day: bool,
    pub kind: String,
    pub title: String,
    /// Titel zum Anzeigen (ohne Datum, wo das moeglich ist)
    pub short: String,
    pub course: Option<i64>,
    /// lernweb | abschnitt | label
    pub source: String,
    pub overdue: bool,
}

fn read<T: for<'a> Deserialize<'a> + Default>(path: std::path::PathBuf) -> T {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn merge(dl: DlFile, ev: EvFile) -> Vec<Event> {
    let mut out = Vec::new();
    let mut lw_days: HashSet<(Option<i64>, String)> = HashSet::new();
    for d in dl.items {
        let Some(ts) = d.ts else { continue };
        lw_days.insert((d.kurs_id, d.faellig.get(..10).unwrap_or("").to_string()));
        out.push(Event {
            id: format!("lw-{}-{}", ts, d.kurs_id.unwrap_or(0)),
            ts,
            all_day: false,
            kind: if matches!(d.typ.as_deref(), Some("assign" | "quiz")) { "frist" } else { "termin" }.into(),
            short: d.titel.clone(),
            title: d.titel,
            course: d.kurs_id,
            source: "lernweb".into(),
            overdue: d.ueberfaellig,
        });
    }
    for e in ev.items {
        if e.kind == "frist" && lw_days.contains(&(e.course_id, e.day.clone())) {
            continue;
        }
        let short = if e.short.is_empty() { e.title.clone() } else { e.short };
        out.push(Event { id: e.id, ts: e.ts, all_day: e.all_day, kind: e.kind, title: e.title, short, course: e.course_id, source: e.source, overdue: false });
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
    out
}

pub fn load(paths: &Paths) -> Vec<Event> {
    merge(read(paths.project.join("data").join("deadlines.json")), read(paths.project.join("data").join("events.json")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(dl: &str, ev: &str) -> Vec<Event> {
        merge(serde_json::from_str(dl).unwrap(), serde_json::from_str(ev).unwrap())
    }

    #[test]
    fn merges_sorts_and_prefers_learnweb_for_the_same_deadline() {
        let out = parse(
            r#"{"items": [{"ts": 1800000000, "faellig": "2027-01-22 12:00", "ueberfaellig": false, "titel": "Exercise IV", "typ": "assign", "kurs_id": 7},
                          {"ts": 1790000000, "faellig": "2026-09-21 05:00", "ueberfaellig": true, "titel": "Termin", "typ": "meeting", "kurs_id": 8},
                          {"titel": "ohne Zeit"}]}"#,
            r#"{"items": [{"id": "a", "ts": 1799999000, "day": "2027-01-22", "all_day": false, "kind": "frist", "title": "The deadline is 22 January 2027, 12 noon.", "course_id": 7, "source": "label"},
                          {"id": "b", "ts": 1799000000, "day": "2027-01-11", "all_day": true, "kind": "frist", "title": "Frist anderer Tag", "course_id": 7, "source": "label"},
                          {"id": "c", "ts": 1800000500, "day": "2027-01-22", "all_day": true, "kind": "sitzung", "title": "22 January: Sitzung", "short": "Sitzung", "course_id": 7, "source": "abschnitt"}]}"#,
        );
        let ids: Vec<&str> = out.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["lw-1790000000-8", "b", "lw-1800000000-7", "c"]); // Label-Frist "a" entfällt, Sitzung und andere Tage bleiben
        assert_eq!(out[0].kind, "termin");
        assert!(out[0].overdue && !out[2].overdue);
        assert_eq!(out[2].kind, "frist");
        assert_eq!(out[1].short, "Frist anderer Tag"); // ohne short in der Datei gilt der Titel
        assert_eq!(out[3].short, "Sitzung");
        assert_eq!(out[2].short, "Exercise IV");
    }

    #[test]
    fn empty_and_broken_files_give_no_events() {
        assert!(parse("{}", "{}").is_empty());
        let none: DlFile = read(std::env::temp_dir().join("kursbuch-gibt-es-nicht.json"));
        assert!(none.items.is_empty());
    }
}
