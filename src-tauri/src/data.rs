//! Liest den Stand der Python-Seite (State, Konfiguration) und baut daraus die Ansichten.
//! Die App schreibt hier nichts; Aenderungen laufen ueber die CLI (ab Phase 4).

use crate::model::{course_kind, semester_rank, split_name, Cm, Config, CourseRec, State};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// Wo die Python-Seite liegt und wo die App ihre eigenen Dateien ablegt. Zwei Betriebsarten:
/// * Entwickler: `uv run python -m learnweb.cli` im Projektordner `learnweb-mcp` (Nojos Einrichtung; geplanter Sync und MCP-Server benutzen denselben Ordner),
/// * mitgeliefert: `learnweb-bridge.exe` aus dem Installer, Daten im App-Ordner (`bridge/`), gesagt per `LEARNWEB_HOME`.
/// `settings.json` im App-Ordner darf `project` und `uv` setzen (erzwingt Entwickler) und mit `"notch": false` die Notch-Karte abschalten.
#[derive(Clone)]
pub struct Paths {
    /// Ordner mit data/ und sync_config.json
    pub project: PathBuf,
    pub uv: PathBuf,
    /// App-Ordner (colors.json, visits.json, settings.json)
    pub config: PathBuf,
    /// Karte „naechste Frist“ an die Notch senden
    pub notch: bool,
    /// mitgelieferte Bruecke; `None` = Entwickler-Betrieb mit uv
    pub bridge: Option<PathBuf>,
}

/// Betriebsart waehlen: ein ausdrueckliches Projekt (Umgebung, settings.json) oder ein vorhandenes `~/learnweb-mcp` mit uv bleibt Entwickler-Betrieb,
/// sonst die mitgelieferte Bruecke, wenn es sie gibt. Rueckgabe: (Projektordner, Bruecke)
pub fn choose(explicit: Option<PathBuf>, home: &Path, uv: &Path, bundled: Option<PathBuf>, config: &Path) -> (PathBuf, Option<PathBuf>) {
    let dev = home.join("learnweb-mcp");
    if let Some(p) = explicit {
        return (p, None);
    }
    if dev.join("pyproject.toml").is_file() && uv.is_file() {
        return (dev, None);
    }
    match bundled.filter(|b| b.is_file()) {
        Some(b) => (config.join("bridge"), Some(b)),
        None => (dev, None),
    }
}

/// Die mitgelieferte Bruecke: KURSBUCH_BRIDGE (Test-Hook, Programm oder Ordner) oder die Ressource des Installers
fn bundled_bridge(app: &AppHandle) -> Option<PathBuf> {
    let exe = "learnweb-bridge.exe";
    if let Some(p) = std::env::var_os("KURSBUCH_BRIDGE").map(PathBuf::from) {
        return Some(if p.is_dir() { p.join(exe) } else { p });
    }
    Some(app.path().resource_dir().ok()?.join("bridge").join("learnweb-bridge").join(exe))
}

impl Paths {
    pub fn load(app: &AppHandle) -> Paths {
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
        // KURSBUCH_PROJECT und KURSBUCH_CONFIG: Test-Hook, damit sich die App gegen Kopien ausprobieren laesst
        let config = std::env::var_os("KURSBUCH_CONFIG").map(PathBuf::from).or_else(|| app.path().app_config_dir().ok()).unwrap_or_else(|| home.join(".kursbuch"));
        let mut explicit = std::env::var_os("KURSBUCH_PROJECT").map(PathBuf::from);
        let mut uv = home.join(".local").join("bin").join("uv.exe");
        let mut notch = true;
        if let Some(v) = std::fs::read(config.join("settings.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
            if let Some(s) = v["project"].as_str() {
                explicit = Some(PathBuf::from(s));
            }
            if let Some(s) = v["uv"].as_str() {
                uv = PathBuf::from(s);
            }
            if let Some(b) = v["notch"].as_bool() {
                notch = b;
            }
        }
        let (project, bridge) = choose(explicit, &home, &uv, bundled_bridge(app), &config);
        if bridge.is_some() {
            let _ = std::fs::create_dir_all(&project); // die Bruecke legt data/ und sync_config.json hier an
        }
        Paths { project, uv, config, notch, bridge }
    }

    pub fn state_file(&self) -> PathBuf {
        self.project.join("data").join("sync_state.json")
    }

    pub fn config_file(&self) -> PathBuf {
        self.project.join("sync_config.json")
    }
}

type Cache = Mutex<Option<(SystemTime, u64, Arc<State>)>>;
static CACHE: Cache = Mutex::new(None);

/// State laden; nur neu geparst, wenn sich Zeit oder Groesse der Datei geaendert haben. Ein Sync schreibt ueber eine
/// Nebendatei und benennt sie um; trifft das Lesen genau den Wechsel, hilft ein zweiter Versuch.
pub fn state(paths: &Paths) -> Result<Arc<State>, String> {
    let file = paths.state_file();
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150));
        }
        let meta = match std::fs::metadata(&file) {
            Ok(m) => m,
            Err(_) => return Err("no_state".into()),
        };
        let key = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
        if let Some((t, l, s)) = CACHE.lock().unwrap().as_ref() {
            if (*t, *l) == key {
                return Ok(s.clone());
            }
        }
        match std::fs::read(&file).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<State>(&b).map_err(|e| e.to_string())) {
            Ok(s) => {
                let s = Arc::new(s);
                *CACHE.lock().unwrap() = Some((key.0, key.1, s.clone()));
                return Ok(s);
            }
            Err(e) => last = e,
        }
    }
    Err(format!("Der Stand von LearnWeb ist nicht lesbar: {last}"))
}

pub fn ziel(paths: &Paths) -> Result<PathBuf, String> {
    let b = std::fs::read(paths.config_file()).map_err(|_| "Die Konfiguration des Syncs fehlt (sync_config.json).".to_string())?;
    let c: Config = serde_json::from_slice(&b).map_err(|e| format!("sync_config.json ist nicht lesbar: {e}"))?;
    Ok(PathBuf::from(c.ziel))
}

pub fn course<'a>(s: &'a State, id: i64) -> Result<&'a CourseRec, String> {
    s.courses.get(&id.to_string()).ok_or_else(|| "Kurs nicht gefunden.".to_string())
}

/// Labels sind nur Text im Kurs (Ueberschriften, Hinweise) und zaehlen nicht als Inhalt (Zahlen, „Neu“)
pub fn visible(cm: &Cm) -> bool {
    cm.typ != "label"
}

// --------------------------------------------------------------------------- Ansichten

#[derive(Serialize)]
pub struct Overview {
    /// ok | no_state (noch kein Sync) | error
    pub status: &'static str,
    pub error: Option<String>,
    pub last_run: Option<i64>,
    pub courses: Vec<CourseCard>,
}

#[derive(Serialize)]
pub struct CourseCard {
    pub id: i64,
    pub title: String,
    pub semester: Option<String>,
    pub teacher: Option<String>,
    /// vorlesung | seminar | uebung, wenn der Titel es verraet
    pub kind: Option<&'static str>,
    /// Farbton des Kurses (0-359, bleibt gleich)
    pub hue: u16,
    pub activities: usize,
    pub files: usize,
    pub skipped: usize,
    pub errors: usize,
}

pub fn overview(paths: &Paths) -> Overview {
    let s = match state(paths) {
        Ok(s) => s,
        Err(e) if e == "no_state" => return Overview { status: "no_state", error: None, last_run: None, courses: vec![] },
        Err(e) => return Overview { status: "error", error: Some(e), last_run: None, courses: vec![] },
    };
    let hues = crate::colors::hues(paths, &s.courses.values().map(|c| c.id).collect::<Vec<_>>());
    let mut courses: Vec<CourseCard> = s
        .courses
        .values()
        .map(|c| {
            let n = split_name(&c.name);
            let cms: Vec<&Cm> = c.cms.values().filter(|m| visible(m)).collect();
            CourseCard {
                id: c.id,
                kind: course_kind(&n.title),
                title: n.title,
                semester: n.semester,
                teacher: n.teacher,
                hue: hues.get(&c.id).copied().unwrap_or(283),
                activities: cms.len(),
                files: cms.iter().map(|m| m.files.len()).sum(),
                skipped: cms.iter().map(|m| m.skipped.len()).sum(),
                errors: cms.iter().filter(|m| m.error.is_some()).count(),
            }
        })
        .collect();
    courses.sort_by(|a, b| {
        semester_rank(b.semester.as_deref())
            .cmp(&semester_rank(a.semester.as_deref()))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Overview { status: "ok", error: None, last_run: s.last_run, courses }
}

#[derive(Serialize)]
pub struct CourseView {
    pub id: i64,
    pub title: String,
    pub semester: Option<String>,
    pub teacher: Option<String>,
    pub hue: u16,
    pub web: bool,
    pub note: bool,
    pub sections: Vec<SectionView>,
}

#[derive(Serialize)]
pub struct SectionView {
    pub title: String,
    pub items: Vec<ItemView>,
}

#[derive(Serialize)]
pub struct ItemView {
    pub cmid: i64,
    pub name: String,
    pub typ: String,
    pub files: Vec<FileView>,
    /// Groessen (MB) der Dateien, die zu gross zum Spiegeln waren
    pub skipped_mb: Vec<f64>,
    pub error: bool,
    /// hat eine Seite in LearnWeb, die sich im Browser oeffnen laesst
    pub web: bool,
}

#[derive(Serialize)]
pub struct FileView {
    pub idx: usize,
    pub name: String,
    pub ext: String,
}

/// Nur Adressen innerhalb von LearnWeb werden im Browser geoeffnet
pub const WEB_BASE: &str = "https://www.uni-muenster.de/LearnWeb/";

pub fn is_web(url: &Option<String>) -> bool {
    url.as_deref().is_some_and(|u| u.starts_with(WEB_BASE))
}

pub fn note_path(ziel: &Path, c: &CourseRec) -> PathBuf {
    ziel.join(&c.dir).join(format!("{}.md", c.dir))
}

pub fn course_view(paths: &Paths, id: i64) -> Result<CourseView, String> {
    let s = state(paths)?;
    let c = course(&s, id)?;
    let n = split_name(&c.name);
    // die Notiz-Knoepfe gibt es nur in einem Obsidian-Tresor (Freunde ohne Obsidian sehen sie ausgegraut)
    let note = ziel(paths).map(|z| crate::settings::is_vault(&z) && note_path(&z, c).is_file()).unwrap_or(false);
    let hue = crate::colors::hues(paths, &[c.id]).get(&c.id).copied().unwrap_or(283);
    // Labels bleiben dabei: ihr Text (Hinweise, Fristen) gehoert zur Kursseite; die Oberflaeche zeigt ihn als Absatz
    let sections = c
        .layout
        .iter()
        .map(|(title, ids)| SectionView {
            title: title.clone(),
            items: ids
                .iter()
                .filter_map(|k| Some((k.parse::<i64>().ok()?, c.cms.get(k)?)))
                .map(|(cmid, m)| ItemView {
                    cmid,
                    name: m.name.clone(),
                    typ: m.typ.clone(),
                    files: m
                        .files
                        .iter()
                        .enumerate()
                        .map(|(idx, f)| {
                            let name = f.rsplit('/').next().unwrap_or(f).to_string();
                            let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
                            FileView { idx, name, ext }
                        })
                        .collect(),
                    skipped_mb: m.skipped.iter().map(|x| x.mb).collect(),
                    error: m.error.is_some(),
                    web: is_web(&m.url),
                })
                .collect(),
        })
        .collect();
    Ok(CourseView { id: c.id, title: n.title, semester: n.semester, teacher: n.teacher, hue, web: is_web(&c.url), note, sections })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kursbuch-data-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn developer_mode_stays_when_a_project_and_uv_exist_or_one_is_named() {
        let home = tmp("dev");
        std::fs::create_dir_all(home.join("learnweb-mcp")).unwrap();
        std::fs::write(home.join("learnweb-mcp").join("pyproject.toml"), "x").unwrap();
        let uv = home.join("uv.exe");
        std::fs::write(&uv, "x").unwrap();
        let bridge = home.join("learnweb-bridge.exe");
        std::fs::write(&bridge, "x").unwrap();
        // Nojos Fall: Projekt und uv da -> Entwickler, auch wenn eine Bruecke mitgeliefert ist
        assert_eq!(choose(None, &home, &uv, Some(bridge.clone()), &home.join("cfg")), (home.join("learnweb-mcp"), None));
        // ausdrueckliches Projekt (Test-Hook, settings.json) gewinnt immer
        assert_eq!(choose(Some(r"X:\p".into()), &home, &uv, Some(bridge), &home.join("cfg")), (PathBuf::from(r"X:\p"), None));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn friends_get_the_bundled_bridge_and_its_data_in_the_app_folder() {
        let home = tmp("friend");
        let cfg = home.join("AppData").join("kursbuch");
        let bridge = home.join("learnweb-bridge.exe");
        std::fs::write(&bridge, "x").unwrap();
        let none = home.join("gibt-es-nicht.exe");
        assert_eq!(choose(None, &home, &none, Some(bridge.clone()), &cfg), (cfg.join("bridge"), Some(bridge.clone())));
        // ein Ordner learnweb-mcp ohne uv ist kein Entwickler-Betrieb
        std::fs::create_dir_all(home.join("learnweb-mcp")).unwrap();
        std::fs::write(home.join("learnweb-mcp").join("pyproject.toml"), "x").unwrap();
        assert_eq!(choose(None, &home, &none, Some(bridge.clone()), &cfg).1, Some(bridge));
        // weder Projekt noch Bruecke: Entwickler-Vorgabe (die Fehlermeldung kommt beim ersten Aufruf)
        assert_eq!(choose(None, &home, &none, Some(none.clone()), &cfg), (home.join("learnweb-mcp"), None));
        assert_eq!(choose(None, &home, &none, None, &cfg).1, None);
        let _ = std::fs::remove_dir_all(&home);
    }
}
