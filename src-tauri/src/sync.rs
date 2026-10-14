//! Sync aus der App: startet `learnweb.cli sync` (Python-Seite, mit der Sperre gegen gleichzeitige Laeufe) und meldet die
//! JSON-Zeilen als Ereignis `sync-event` an die Oberflaeche (Fortschritt: Kurs fuer Kurs). Es laeuft hoechstens ein Sync zugleich.
//! LearnWeb wird nur von der Python-Seite angesprochen, mit deren Pause zwischen den Anfragen.

use crate::data::Paths;
use crate::py;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Eine Zeile der Python-Seite als Ereignis; Zeilen, die kein JSON-Objekt mit `event` sind, werden ignoriert
pub fn event(line: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    v.get("event")?.as_str()?;
    Some(v)
}

/// Startet den Sync im Hintergrund; `false`, wenn schon einer laeuft
#[tauri::command]
pub fn sync_start(app: AppHandle) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::spawn(move || {
        let paths = app.state::<Paths>().inner().clone();
        let _ = app.emit("sync-event", json!({"event": "begin"}));
        let mut done = false;
        let res = py::stream(&paths, &["sync", "--json"], |l| {
            if let Some(v) = event(l) {
                if v["event"] == "done" || v["event"] == "error" {
                    done = true; // die Python-Seite hat das Ergebnis selbst gemeldet
                }
                let _ = app.emit("sync-event", v);
            }
        });
        let code = res.as_ref().copied().unwrap_or(-1);
        // Abbruch ohne eigenes Ereignis der Python-Seite (uv fehlt, Absturz): als Fehler melden
        if !done && code != 0 {
            let msg = res.err().unwrap_or_else(|| "Der Sync ist abgebrochen.".into());
            let _ = app.emit("sync-event", json!({"event": "error", "code": "internal", "message": msg}));
        }
        let _ = app.emit("sync-event", json!({"event": "end", "code": code}));
        RUNNING.store(false, Ordering::SeqCst);
    });
    true
}

#[tauri::command]
pub fn sync_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_json_objects_with_an_event_pass() {
        assert_eq!(event("{\"event\": \"course\", \"index\": 2}").unwrap()["index"], 2);
        assert_eq!(event("  {\"event\":\"done\"}  ").unwrap()["event"], "done");
        for bad in ["", "Warnung: x", "[1,2]", "{\"x\": 1}", "{\"event\": 5}", "{kaputt"] {
            assert!(event(bad).is_none(), "{bad:?}");
        }
    }
}
