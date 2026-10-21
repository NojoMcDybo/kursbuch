//! Vorschlaege fuer Termine und Fristen aus den Kurstexten (Python: learnweb/suggest.py, data/suggestions.json). Sie erscheinen im
//! Zeitstrahl und in der Wochenansicht gestrichelt und werden erst nach Bestaetigung zu Terminen (`accepted`); Verworfenes kommt nicht
//! wieder (`dismissed`). Beides steht in `suggestions.json` im App-Ordner; die Python-Seite wird davon nie veraendert.

use crate::data::Paths;
use crate::events::Event;
use crate::store;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;
use tauri::State;

#[derive(Deserialize)]
struct Raw {
    id: String,
    course_id: Option<i64>,
    kind: String,
    ts: i64,
    #[serde(default)]
    all_day: bool,
    #[serde(default)]
    title: String,
    #[serde(default)]
    short: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    confidence: String,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    items: Vec<Raw>,
}

#[derive(Serialize, Deserialize, Default)]
struct Decisions {
    #[serde(default)]
    accepted: BTreeSet<String>,
    #[serde(default)]
    dismissed: BTreeSet<String>,
}

fn decisions_file(paths: &Paths) -> PathBuf {
    paths.config.join("suggestions.json")
}

/// „s-“ und zwoelf Hexziffern, wie suggest.py sie bildet; alles andere kommt nie von dort
pub fn valid_id(id: &str) -> bool {
    id.len() == 14 && id.starts_with("s-") && id[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn kind_ok(kind: &str) -> bool {
    matches!(kind, "frist" | "pruefung" | "termin")
}

/// Vorschlaege an die Termine haengen: offene gestrichelt (`suggested`), uebernommene als normale Termine, verworfene gar nicht
pub fn apply(paths: &Paths, events: &mut Vec<Event>) {
    let f: File = std::fs::read(paths.project.join("data").join("suggestions.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if f.items.is_empty() {
        return;
    }
    let d: Decisions = store::read(&decisions_file(paths)).ok().flatten().unwrap_or_default();
    for r in f.items {
        if !valid_id(&r.id) || !kind_ok(&r.kind) || r.ts <= 0 || d.dismissed.contains(&r.id) {
            continue;
        }
        let suggested = !d.accepted.contains(&r.id);
        let short = if r.short.is_empty() { r.title.chars().take(40).collect() } else { r.short };
        let detail = [r.source.as_str(), &if r.confidence.is_empty() { String::new() } else { format!("Sicherheit {}", r.confidence) }]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" · ");
        events.push(Event {
            id: r.id,
            ts: r.ts,
            all_day: r.all_day,
            kind: r.kind,
            title: r.title.chars().take(200).collect(),
            short,
            course: r.course_id,
            source: "vorschlag".into(),
            overdue: false,
            suggested,
            detail: detail.chars().take(200).collect(),
        });
    }
    events.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
}

pub fn decide(paths: &Paths, id: &str, accept: bool) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Ungültiger Vorschlag.".into());
    }
    let mut d: Decisions = store::read_or_quarantine(&decisions_file(paths)).unwrap_or_default();
    let (add, other) = if accept { (&mut d.accepted, &mut d.dismissed) } else { (&mut d.dismissed, &mut d.accepted) };
    other.remove(id);
    add.insert(id.to_string());
    store::write(&decisions_file(paths), &d)
}

/// Uebernehmen (`accept`) oder verwerfen eines Vorschlags
#[tauri::command]
pub fn suggestion_decide(paths: State<Paths>, id: String, accept: bool) -> Result<(), String> {
    decide(&paths, &id, accept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, items: &str) -> (PathBuf, Paths) {
        let dir = std::env::temp_dir().join(format!("kursbuch-sugg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data").join("suggestions.json"), format!(r#"{{"items": {items}}}"#)).unwrap();
        let p = Paths { project: dir.clone(), uv: dir.clone(), config: dir.join("cfg"), notch: false, bridge: None };
        (dir, p)
    }

    const ITEMS: &str = r#"[
        {"id": "s-0123456789ab", "course_id": 7, "kind": "pruefung", "ts": 1800000000, "title": "Klausur am 19.03.2027", "short": "Prüfung", "source": "Folien.pdf · Seite 4", "confidence": "hoch"},
        {"id": "s-ba9876543210", "course_id": 7, "kind": "frist", "ts": 1790000000, "all_day": true, "title": "Abgabe bis 15.12.", "source": "", "confidence": ""},
        {"id": "s-111111111111", "course_id": 8, "kind": "event", "ts": 1790000001, "title": "falsche Art"},
        {"id": "../etc/passwd", "course_id": 8, "kind": "frist", "ts": 1790000002, "title": "falsche ID"},
        {"id": "s-222222222222", "course_id": 8, "kind": "frist", "ts": 0, "title": "ohne Zeit"}
    ]"#;

    #[test]
    fn open_suggestions_are_marked_and_bad_ones_are_skipped() {
        let (dir, p) = project("a", ITEMS);
        let mut ev = vec![];
        apply(&p, &mut ev);
        assert_eq!(ev.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["s-ba9876543210", "s-0123456789ab"]); // nach Zeit sortiert
        assert!(ev.iter().all(|e| e.suggested && e.source == "vorschlag"));
        assert_eq!((ev[1].kind.as_str(), ev[1].short.as_str(), ev[1].detail.as_str()), ("pruefung", "Prüfung", "Folien.pdf · Seite 4 · Sicherheit hoch"));
        assert!(ev[0].all_day && ev[0].detail.is_empty() && ev[0].short == "Abgabe bis 15.12.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepted_become_plain_events_and_dismissed_never_return() {
        let (dir, p) = project("b", ITEMS);
        decide(&p, "s-0123456789ab", true).unwrap();
        decide(&p, "s-ba9876543210", false).unwrap();
        let mut ev = vec![];
        apply(&p, &mut ev);
        assert_eq!(ev.len(), 1);
        assert!(!ev[0].suggested && ev[0].id == "s-0123456789ab");
        decide(&p, "s-0123456789ab", false).unwrap(); // Meinung geaendert: verworfen statt uebernommen
        let mut ev = vec![];
        apply(&p, &mut ev);
        assert!(ev.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_from_the_webview_are_checked() {
        let (dir, p) = project("c", "[]");
        for bad in ["", "s-", "s-0123456789a", "s-0123456789abc", "x-0123456789ab", "s-0123456789zz", "../../x", "s-0123456789ab\n"] {
            assert!(decide(&p, bad, true).is_err(), "{bad:?}");
        }
        assert!(decide(&p, "s-0123456789AB", true).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_file_no_suggestions() {
        let p = Paths { project: "gibt-es-nicht".into(), uv: "x".into(), config: "gibt-es-nicht".into(), notch: false, bridge: None };
        let mut ev = vec![];
        apply(&p, &mut ev);
        assert!(ev.is_empty());
    }
}
