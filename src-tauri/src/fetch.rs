//! Sofort-Download einer Aktivitaet ueber die Python-Seite (`learnweb.cli fetch`, siehe py.rs): Zugangsdaten, Sperre gegen
//! gleichzeitige Syncs, State, Index und Verzeichnis nachziehen. Die App bekommt nur das Ergebnis.

use crate::data::Paths;
use crate::py;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
struct Out {
    ok: bool,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    skipped: Vec<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

#[derive(Serialize)]
pub struct Fetched {
    pub files: usize,
    pub skipped: usize,
}

/// `code`: too_large | locked | login | learnweb | network | credentials | start; die Oberflaeche zeigt nur `message`
#[derive(Serialize)]
pub struct FetchError {
    pub code: String,
    pub message: String,
}

fn err(code: &str, message: impl Into<String>) -> FetchError {
    FetchError { code: code.into(), message: message.into() }
}

/// Antwort der Python-Seite auswerten
fn parse(stdout: &str) -> Result<Fetched, FetchError> {
    let o: Out = py::last_json(stdout).ok_or_else(|| err("start", "Keine Antwort von der Python-Seite."))?;
    if o.ok {
        Ok(Fetched { files: o.files.len(), skipped: o.skipped.len() })
    } else {
        Err(err(o.code.as_deref().unwrap_or("learnweb"), o.error.unwrap_or_else(|| "Der Download ist fehlgeschlagen.".into())))
    }
}

fn run(paths: &Paths, course: i64, cmid: i64, all_sizes: bool) -> Result<Fetched, FetchError> {
    let (c, m) = (course.to_string(), cmid.to_string());
    let mut args = vec!["fetch", c.as_str(), m.as_str()];
    if all_sizes {
        args.push("--all-sizes");
    }
    parse(&py::cli(paths, &args, None).map_err(|e| err("start", e))?)
}

/// `all_sizes`: auch Dateien laden, die der Sync als zu gross uebersprungen hat (ausdruecklicher Wunsch des Nutzers)
#[tauri::command]
pub async fn fetch(paths: State<'_, Paths>, course: i64, cmid: i64, all_sizes: bool) -> Result<Fetched, FetchError> {
    // `State` lebt nur im Befehl; der Download laeuft auf einem eigenen Thread, damit die Oberflaeche nicht wartet
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run(&p, course, cmid, all_sizes)).await.map_err(|e| err("start", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_last_json_line_and_ignores_noise_before_it() {
        let r = parse("warning: x\n{\"ok\": true, \"files\": [\"a\", \"b\"], \"skipped\": [{\"mb\": 50.0}]}\n").ok().unwrap();
        assert_eq!((r.files, r.skipped), (2, 1));
    }

    #[test]
    fn errors_carry_code_and_message() {
        let e = parse("{\"ok\": false, \"code\": \"too_large\", \"error\": \"Die Datei ist 34 MB groß.\"}").err().unwrap();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("too_large", "Die Datei ist 34 MB groß."));
        let e = parse("{\"ok\": false, \"error\": \"Aktivität nicht gefunden.\"}").err().unwrap();
        assert_eq!(e.code, "learnweb");
        assert_eq!(parse("").err().unwrap().code, "start");
        assert_eq!(parse("Traceback (most recent call last):\n  boom").err().unwrap().code, "start");
    }
}
