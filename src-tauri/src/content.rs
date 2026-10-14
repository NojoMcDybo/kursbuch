//! Inhalte ohne Datei aus data/content.json (Python-Seite: learnweb/content.py): Ankuendigungen, Aufgaben, Dozenten mit Kontakt
//! und Quelle, weitere Kontakte aus Kurstexten. Die App liest nur; die Faelligkeit der Aufgaben steht in data/deadlines.json.

use crate::data::{self, Paths};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Link {
    #[serde(default)]
    pub text: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FileRef {
    #[serde(default)]
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct News {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub forum: Option<i64>,
    #[serde(default)]
    pub forum_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub ts: Option<i64>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub files: Vec<FileRef>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Assignment {
    pub cmid: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub intro: String,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub grading: String,
    #[serde(default)]
    pub remaining: String,
    /// Faelligkeit (Unix) aus den Fristen von LearnWeb, wenn bekannt
    #[serde(default, skip_deserializing)]
    pub due_ts: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Teacher {
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub checked: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Contact {
    pub email: String,
    #[serde(default)]
    pub r#where: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Extras {
    #[serde(default)]
    pub news: Vec<News>,
    #[serde(default)]
    pub assignments: Vec<Assignment>,
    #[serde(default)]
    pub teachers: Vec<Teacher>,
    #[serde(default)]
    pub contacts: Vec<Contact>,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    courses: BTreeMap<String, Extras>,
}

/// Faelligkeit der Aufgabe `cmid` aus den Fristen (die URL enthaelt `id=<cmid>`)
fn due_ts(deadlines: &serde_json::Value, cmid: i64) -> Option<i64> {
    let tag = format!("id={cmid}");
    deadlines["items"].as_array()?.iter().find_map(|d| {
        let url = d["url"].as_str()?;
        let hit = url.split(['?', '&']).any(|p| p == tag);
        hit.then(|| d["ts"].as_i64()).flatten()
    })
}

pub fn extras(paths: &Paths, course: i64) -> Result<Extras, String> {
    let f: File = match std::fs::read(paths.project.join("data").join("content.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("content.json ist nicht lesbar: {e}"))?,
        Err(_) => File::default(), // noch nicht geholt: leer
    };
    let mut x = f.courses.into_iter().find(|(k, _)| k == &course.to_string()).map(|(_, v)| v).unwrap_or_default();
    let deadlines: serde_json::Value = std::fs::read(paths.project.join("data").join("deadlines.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for a in &mut x.assignments {
        a.due_ts = due_ts(&deadlines, a.cmid);
    }
    // faellige zuerst, dann ohne Datum
    x.assignments.sort_by_key(|a| (a.due_ts.is_none(), a.due_ts.unwrap_or(0)));
    Ok(x)
}

#[tauri::command]
pub fn course_extras(paths: State<Paths>, course: i64) -> Result<Extras, String> {
    let state = data::state(&paths)?;
    data::course(&state, course)?;
    extras(&paths, course)
}

/// Nur http(s) und mailto, nie ein Pfad oder Programm; der Nutzer hat den Verweis angeklickt
pub fn external_ok(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    url.len() <= 800 && !url.chars().any(char::is_control) && (l.starts_with("https://") || l.starts_with("http://") || l.starts_with("mailto:"))
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !external_ok(&url) {
        return Err("Dieser Verweis wird nicht geöffnet.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_web_and_mail_links_open() {
        for ok in ["https://teams.microsoft.com/l/x", "http://a.de", "mailto:a@b.de", "HTTPS://A.DE"] {
            assert!(external_ok(ok), "{ok}");
        }
        for bad in ["", "file:///C:/Windows/notepad.exe", "C:\\x.exe", "javascript:alert(1)", "ftp://x", "https://a.de/\n", "data:text/html,x", &format!("https://{}", "a".repeat(800))] {
            assert!(!external_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn due_dates_match_the_activity_id_exactly() {
        let d = json!({"items": [{"ts": 100, "url": "https://x/mod/assign/view.php?id=4212544&action=editsubmission"}, {"ts": 200, "url": "https://x/mod/assign/view.php?id=42125441"}]});
        assert_eq!(due_ts(&d, 4212544), Some(100));
        assert_eq!(due_ts(&d, 421254), None); // Teil einer anderen ID zaehlt nicht
        assert_eq!(due_ts(&d, 42125441), Some(200));
        assert_eq!(due_ts(&json!({}), 1), None);
    }

    #[test]
    fn reads_the_python_file_tolerantly_and_sorts_assignments_by_due_date() {
        let dir = std::env::temp_dir().join(format!("kursbuch-content-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let p = Paths { project: dir.clone(), uv: dir.clone(), config: dir.clone(), notch: false };
        assert!(extras(&p, 7).unwrap().news.is_empty()); // ohne Datei: leer
        std::fs::write(
            dir.join("data").join("content.json"),
            json!({"updated": 1, "courses": {"7": {"news": [{"title": "Hallo", "text": "x", "neues_feld": 1}], "teachers": [{"id": 3, "name": "A B", "email": "a@b.de", "fields": {"Land": "Deutschland"}}],
                "assignments": [{"cmid": 1, "name": "ohne"}, {"cmid": 2, "name": "spaet"}, {"cmid": 3, "name": "frueh"}], "contacts": [{"email": "c@d.de", "where": "Label"}]}}}).to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("data").join("deadlines.json"), json!({"items": [{"ts": 900, "url": "https://x?id=2"}, {"ts": 100, "url": "https://x?id=3"}]}).to_string()).unwrap();
        let x = extras(&p, 7).unwrap();
        assert_eq!((x.news[0].title.as_str(), x.teachers[0].fields["Land"].as_str(), x.contacts[0].r#where.as_str()), ("Hallo", "Deutschland", "Label"));
        assert_eq!(x.assignments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["frueh", "spaet", "ohne"]);
        assert!(extras(&p, 8).unwrap().assignments.is_empty());
        std::fs::write(dir.join("data").join("content.json"), b"{kaputt").unwrap();
        assert!(extras(&p, 7).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
