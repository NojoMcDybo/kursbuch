//! „Neu seit dem letzten Oeffnen“: Der Zeitpunkt des letzten Starts wird beim Start gelesen und dann erst neu gesetzt,
//! die Liste bleibt also fuer die ganze Sitzung stehen. „Gelesen“ setzt sie zurueck (auch ueber Neustarts hinweg).
//! Beim allerersten Start gibt es nichts Neues. Aktivitaeten ohne `seen_at`/`updated_at` (alte Daten) gelten als alt.

use crate::data::{self, Paths};
use crate::model::Cm;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub struct Visits {
    /// Start der vorigen Sitzung (beim allerersten Start: jetzt)
    since: i64,
    /// Start dieser Sitzung, wird als „zuletzt geoeffnet“ gespeichert
    started: i64,
    read_until: Mutex<i64>,
    file: PathBuf,
}

impl Visits {
    pub fn load(paths: &Paths) -> Visits {
        let file = paths.config.join("visits.json");
        let v: serde_json::Value = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let started = now();
        let visits = Visits {
            since: v["last_open"].as_i64().unwrap_or(started),
            started,
            read_until: Mutex::new(v["read_until"].as_i64().unwrap_or(0)),
            file,
        };
        visits.save();
        visits
    }

    fn save(&self) {
        let body = serde_json::json!({ "last_open": self.started, "read_until": *self.read_until.lock().unwrap() });
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.file, body.to_string());
    }

    pub fn threshold(&self) -> i64 {
        self.since.max(*self.read_until.lock().unwrap())
    }

    pub fn mark_read(&self) {
        *self.read_until.lock().unwrap() = now();
        self.save();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub course: i64,
    pub cmid: i64,
    pub name: String,
    pub typ: String,
    /// Nummer der Datei, wenn die Aktivitaet genau eine hat (Klick oeffnet sie)
    pub file: Option<usize>,
    pub ts: i64,
    pub updated: bool,
}

/// Zeitpunkt, zu dem die Aktivitaet neu oder aktualisiert wurde (0 = alt)
fn stamp(cm: &Cm) -> i64 {
    cm.seen_at.unwrap_or(0).max(cm.updated_at.unwrap_or(0))
}

pub fn news(paths: &Paths, visits: &Visits) -> Result<Vec<NewItem>, String> {
    let s = data::state(paths)?;
    let limit = visits.threshold();
    let mut out: Vec<NewItem> = s
        .courses
        .values()
        .flat_map(|c| {
            c.cms.iter().filter(|(_, m)| data::visible(m) && stamp(m) > limit).filter_map(move |(k, m)| {
                Some(NewItem {
                    course: c.id,
                    cmid: k.parse().ok()?,
                    name: m.name.clone(),
                    typ: m.typ.clone(),
                    file: (m.files.len() == 1).then_some(0),
                    ts: stamp(m),
                    updated: m.updated_at.unwrap_or(0) > m.seen_at.unwrap_or(0),
                })
            })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| a.name.cmp(&b.name)));
    out.truncate(60);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cm(seen: Option<i64>, upd: Option<i64>) -> Cm {
        Cm { name: "x".into(), typ: "resource".into(), seen_at: seen, updated_at: upd, ..Default::default() }
    }

    #[test]
    fn old_data_without_timestamps_is_old() {
        assert_eq!(stamp(&cm(None, None)), 0);
        assert_eq!(stamp(&cm(Some(10), None)), 10);
        assert_eq!(stamp(&cm(Some(10), Some(30))), 30);
    }

    #[test]
    fn first_start_has_nothing_new_and_mark_read_survives_restarts() {
        let dir = std::env::temp_dir().join(format!("kursbuch-visits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths { project: dir.clone(), uv: dir.clone(), config: dir.clone(), notch: false };
        let first = Visits::load(&paths);
        assert!(first.threshold() >= now() - 2, "beim ersten Start zaehlt alles bis jetzt als gesehen");
        let t = first.threshold();
        let second = Visits::load(&paths); // neuer Start: „seit“ ist der Start davor
        assert!(second.threshold() >= t);
        std::fs::write(dir.join("visits.json"), r#"{"last_open": 100, "read_until": 500}"#).unwrap();
        let third = Visits::load(&paths);
        assert_eq!(third.threshold(), 500); // „Gelesen“ aus einer frueheren Sitzung gilt weiter
        std::fs::write(dir.join("visits.json"), r#"{"last_open": 900, "read_until": 500}"#).unwrap();
        assert_eq!(Visits::load(&paths).threshold(), 900);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
