//! Dateien, Links, Notizen und Ordner oeffnen. Die Oberflaeche nennt nur IDs (Kurs, Aktivitaet, Dateinummer); Pfade
//! und Adressen kommen aus dem State. Dateien muessen unter `ziel` liegen, Adressen in LearnWeb.

use crate::data::{self, Paths};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

/// Relativer Pfad aus dem State (mit `/`) -> echter Pfad unter `ziel`. Kein `..`, kein Laufwerk, kein Datenstrom
/// (`datei:strom`), und nach dem Aufloesen (Verknuepfungen!) muss er noch unter `ziel` liegen.
pub fn resolve(ziel: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut p = ziel.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return Err("Ungültiger Dateipfad.".into());
        }
        p.push(part);
    }
    let real = p.canonicalize().map_err(|_| "Die Datei gibt es nicht (mehr).".to_string())?;
    let base = ziel.canonicalize().map_err(|_| "Der Zielordner fehlt.".to_string())?;
    if !real.starts_with(&base) {
        return Err("Die Datei liegt außerhalb des Kursordners.".into());
    }
    Ok(simplify(real))
}

/// `\\?\`-Pfade (aus canonicalize) sind fuer andere Programme oft unbequem; kurze Pfade bekommen die normale Form zurueck
fn simplify(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(r) if !r.starts_with("UNC\\") && r.len() < 250 => PathBuf::from(r),
        _ => p,
    }
}

#[derive(Debug, PartialEq)]
enum Route {
    /// PDF -> Folio (Windows hat Edge als Standard, nicht Folio)
    Folio,
    /// Office, Bilder, Audio, Text -> Standardprogramm
    Shell,
    /// alles andere wird nie ausgefuehrt, nur im Explorer gezeigt
    Reveal,
}

fn route(ext: &str) -> Route {
    match ext {
        "pdf" => Route::Folio,
        "docx" | "doc" | "pptx" | "ppt" | "xlsx" | "xls" | "odt" | "odp" | "ods" | "rtf" | "txt" | "md" | "csv" | "jpg" | "jpeg"
        | "png" | "gif" | "webp" | "mp3" | "m4a" | "wav" | "mp4" | "mov" => Route::Shell,
        _ => Route::Reveal,
    }
}

fn folio_exe() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Folio").join("folio.exe");
    p.is_file().then_some(p)
}

fn open_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let shell = || app.opener().open_path(path.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string());
    match route(&ext) {
        Route::Folio => {
            if let Some(exe) = folio_exe() {
                if std::process::Command::new(exe).arg(path).spawn().is_ok() {
                    return Ok(());
                }
            }
            shell() // Folio fehlt: Standardprogramm
        }
        Route::Shell => shell(),
        Route::Reveal => app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn open_file(app: AppHandle, paths: State<Paths>, course: i64, cmid: i64, idx: usize) -> Result<(), String> {
    let s = data::state(&paths)?;
    let c = data::course(&s, course)?;
    let cm = c.cms.get(&cmid.to_string()).ok_or("Aktivität nicht gefunden.")?;
    let rel = cm.files.get(idx).ok_or("Datei nicht gefunden.")?;
    open_path(&app, &resolve(&data::ziel(&paths)?, rel)?)
}

/// Seite in LearnWeb im Browser: die der Aktivitaet, ohne `cmid` die des Kurses
#[tauri::command]
pub fn open_web(app: AppHandle, paths: State<Paths>, course: i64, cmid: Option<i64>) -> Result<(), String> {
    let s = data::state(&paths)?;
    let c = data::course(&s, course)?;
    let url = match cmid {
        Some(id) => &c.cms.get(&id.to_string()).ok_or("Aktivität nicht gefunden.")?.url,
        None => &c.url,
    };
    if !data::is_web(url) {
        return Err("Dafür gibt es keine Seite in LearnWeb.".into());
    }
    app.opener().open_url(url.clone().unwrap_or_default(), None::<&str>).map_err(|e| e.to_string())
}

/// Obsidian-Adresse der Kursnotiz. Tresor = Ordner ueber `ziel` ("Second Brain"), Datei = "<ziel>/<dir>/<dir>" ohne .md
const ENC: &AsciiSet = &NON_ALPHANUMERIC.remove(b'/').remove(b'-').remove(b'_').remove(b'.').remove(b'~');

pub fn obsidian_url(ziel: &Path, dir: &str) -> Option<String> {
    let vault = ziel.parent()?.file_name()?.to_str()?;
    let sub = ziel.file_name()?.to_str()?;
    let enc = |s: &str| utf8_percent_encode(s, ENC).to_string();
    Some(format!("obsidian://open?vault={}&file={}", enc(vault), enc(&format!("{sub}/{dir}/{dir}"))))
}

#[tauri::command]
pub fn open_note(app: AppHandle, paths: State<Paths>, course: i64) -> Result<(), String> {
    let s = data::state(&paths)?;
    let c = data::course(&s, course)?;
    let ziel = data::ziel(&paths)?;
    if !data::note_path(&ziel, c).is_file() {
        return Err("Die Kursnotiz gibt es noch nicht (nach dem nächsten Sync).".into());
    }
    let url = obsidian_url(&ziel, &c.dir).ok_or("Der Obsidian-Tresor lässt sich nicht bestimmen.")?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_folder(app: AppHandle, paths: State<Paths>, course: i64) -> Result<(), String> {
    let s = data::state(&paths)?;
    let c = data::course(&s, course)?;
    let dir = data::ziel(&paths)?.join(&c.dir);
    if !dir.is_dir() {
        return Err("Der Kursordner fehlt.".into());
    }
    app.opener().open_path(dir.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Temp-Ordner mit Inhalt, am Ende weg
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("kursbuch-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(p.join("ziel").join("Kurs A").join("01 Woche")).unwrap();
            std::fs::write(p.join("ziel").join("Kurs A").join("01 Woche").join("Folien.pdf"), b"x").unwrap();
            std::fs::write(p.join("geheim.txt"), b"x").unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolve_accepts_files_under_ziel() {
        let t = Tmp::new("ok");
        let p = resolve(&t.0.join("ziel"), "Kurs A/01 Woche/Folien.pdf").unwrap();
        assert!(p.is_file() && p.ends_with("Folien.pdf"));
        assert!(!p.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn resolve_rejects_everything_outside() {
        let t = Tmp::new("bad");
        let z = t.0.join("ziel");
        for rel in ["../geheim.txt", "Kurs A/../../geheim.txt", "/geheim.txt", "C:/Windows/notepad.exe", "Kurs A\\01 Woche\\Folien.pdf",
                    "Kurs A/01 Woche/Folien.pdf:stream", "", ".", "Kurs A//01 Woche", "Kurs A/gibt-es-nicht.pdf"] {
            assert!(resolve(&z, rel).is_err(), "{rel:?} muss abgelehnt werden");
        }
    }

    #[test]
    fn only_known_document_types_are_run_everything_else_is_only_shown() {
        assert_eq!(route("pdf"), Route::Folio);
        assert_eq!(route("pptx"), Route::Shell);
        for ext in ["exe", "bat", "cmd", "ps1", "lnk", "msi", "js", "vbs", "scr", "html", "svg", ""] {
            assert_eq!(route(ext), Route::Reveal, "{ext:?}");
        }
    }

    #[test]
    fn obsidian_address_for_the_course_note() {
        let ziel = Path::new(r"D:\Second Brain\Second Brain\LearnWeb");
        assert_eq!(
            obsidian_url(ziel, "Gulliver's Travels at 300 WiSe 2026_27, Kirsten Ju").unwrap(),
            "obsidian://open?vault=Second%20Brain&file=LearnWeb/Gulliver%27s%20Travels%20at%20300%20WiSe%202026_27%2C%20Kirsten%20Ju/\
             Gulliver%27s%20Travels%20at%20300%20WiSe%202026_27%2C%20Kirsten%20Ju"
        );
        assert_eq!(obsidian_url(Path::new(r"D:\"), "x"), None);
    }
}
