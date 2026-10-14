//! Erkannte Regeltermine (Python: learnweb/schedule.py, data/schedule.json): Wochentag, oft ohne Uhrzeit, mit Quelle und Sicherheit.
//! Die Oberflaeche legt Funde mit Uhrzeit von selbst im Stundenplan an und fragt bei den anderen nach der Uhrzeit. Was der Nutzer
//! verwirft, kommt nicht wieder (schedule-dismissed.json im App-Ordner).

use crate::data::{self, Paths};
use crate::model::split_name;
use crate::store;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;
use tauri::State;

#[derive(Deserialize)]
struct Raw {
    course_id: i64,
    weekday: u8,
    #[serde(default)]
    start: Option<u16>,
    #[serde(default)]
    end: Option<u16>,
    #[serde(default)]
    room: Option<String>,
    #[serde(default)]
    confidence: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    sessions: u32,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    items: Vec<Raw>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Suggestion {
    /// Schluessel „<kurs>:<wochentag>“ (fuer Verwerfen)
    pub key: String,
    pub course: i64,
    pub title: String,
    pub semester: Option<String>,
    pub weekday: u8,
    pub start: Option<u16>,
    pub end: Option<u16>,
    pub room: Option<String>,
    pub confidence: String,
    pub source: String,
    pub sessions: u32,
}

fn dismissed_file(paths: &Paths) -> PathBuf {
    paths.config.join("schedule-dismissed.json")
}

pub fn key(course: i64, weekday: u8) -> String {
    format!("{course}:{weekday}")
}

pub fn suggestions(paths: &Paths) -> Result<Vec<Suggestion>, String> {
    let f: File = match std::fs::read(paths.project.join("data").join("schedule.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("schedule.json ist nicht lesbar: {e}"))?,
        Err(_) => File::default(),
    };
    let dismissed: BTreeSet<String> = store::read(&dismissed_file(paths)).ok().flatten().unwrap_or_default();
    let state = data::state(paths)?;
    Ok(f.items
        .into_iter()
        .filter(|r| r.weekday < 7 && !dismissed.contains(&key(r.course_id, r.weekday)))
        .filter(|r| match (r.start, r.end) {
            (Some(a), Some(b)) => a < b && b <= 1440,
            (None, None) => true,
            _ => false,
        })
        .filter_map(|r| {
            let c = state.courses.get(&r.course_id.to_string())?;
            let n = split_name(&c.name);
            Some(Suggestion {
                key: key(r.course_id, r.weekday),
                course: r.course_id,
                title: n.title,
                semester: n.semester,
                weekday: r.weekday,
                start: r.start,
                end: r.end,
                room: r.room,
                confidence: r.confidence,
                source: r.source,
                sessions: r.sessions,
            })
        })
        .collect())
}

pub fn dismiss(paths: &Paths, k: &str) -> Result<(), String> {
    if k.len() > 40 || !k.chars().all(|c| c.is_ascii_digit() || c == ':') || k.matches(':').count() != 1 {
        return Err("Ungültiger Schlüssel.".into());
    }
    let mut set: BTreeSet<String> = store::read_or_quarantine(&dismissed_file(paths)).unwrap_or_default();
    set.insert(k.to_string());
    store::write(&dismissed_file(paths), &set)
}

#[tauri::command]
pub fn schedule_get(paths: State<Paths>) -> Result<Vec<Suggestion>, String> {
    suggestions(&paths)
}

#[tauri::command]
pub fn schedule_dismiss(paths: State<Paths>, key: String) -> Result<(), String> {
    dismiss(&paths, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> (PathBuf, Paths) {
        let dir = std::env::temp_dir().join(format!("kursbuch-sched-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(
            dir.join("data").join("sync_state.json"),
            serde_json::json!({"last_run": 1, "courses": {"7": {"id": 7, "name": "VL Sportpsychologie SoSe 2026, Bernd Strauß", "dir": "x", "cms": {}}, "8": {"id": 8, "name": "Seminar WiSe 2026/27", "dir": "y", "cms": {}}}}).to_string(),
        )
        .unwrap();
        let p = Paths { project: dir.clone(), uv: dir.clone(), config: dir.join("cfg"), notch: false };
        (dir, p)
    }

    #[test]
    fn reads_findings_joins_course_names_and_skips_unknown_courses_and_broken_times() {
        let (dir, p) = project("a");
        assert!(suggestions(&p).unwrap().is_empty()); // noch keine Datei
        std::fs::write(
            dir.join("data").join("schedule.json"),
            serde_json::json!({"items": [
                {"course_id": 7, "weekday": 0, "start": 600, "end": 720, "room": "H 4", "confidence": "hoch", "source": "6 Sitzungstermine am Montag", "sessions": 6},
                {"course_id": 8, "weekday": 3, "confidence": "mittel", "source": "3 Sitzungstermine am Donnerstag", "sessions": 3},
                {"course_id": 99, "weekday": 1, "start": null, "end": null},
                {"course_id": 7, "weekday": 9},
                {"course_id": 7, "weekday": 2, "start": 800, "end": 700},
                {"course_id": 7, "weekday": 4, "start": 800}]})
            .to_string(),
        )
        .unwrap();
        let s = suggestions(&p).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].key.as_str(), s[0].title.as_str(), s[0].semester.as_deref(), s[0].start, s[0].room.as_deref()), ("7:0", "VL Sportpsychologie", Some("SoSe 2026"), Some(600), Some("H 4")));
        assert_eq!((s[1].title.as_str(), s[1].start, s[1].end), ("Seminar", None, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dismissed_findings_stay_away_and_bad_keys_are_refused() {
        let (dir, p) = project("b");
        std::fs::write(dir.join("data").join("schedule.json"), serde_json::json!({"items": [{"course_id": 7, "weekday": 0}, {"course_id": 8, "weekday": 3}]}).to_string()).unwrap();
        dismiss(&p, "7:0").unwrap();
        dismiss(&p, "7:0").unwrap(); // zweimal ist egal
        assert_eq!(suggestions(&p).unwrap().iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), ["8:3"]);
        for bad in ["", "7", "7:0:1", "../x:1", "a:1", &"1".repeat(41)] {
            assert!(dismiss(&p, bad).is_err(), "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
