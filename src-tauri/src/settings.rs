//! Einstellungen ohne Kommandozeile (fuer Freunde, die Kursbuch nur installieren): der Ordner fuer die Kursdateien (Downloads, Kursnotizen,
//! `_Verzeichnis.md`). Er steht in `sync_config.json` der Python-Seite (`ziel`); gesetzt und geprueft wird er dort (`cli config set ziel`),
//! die Ordnerwahl macht die Oberflaeche mit dem Dialog-Plugin. Die Betriebsart (mitgelieferte Bruecke oder Entwickler-Betrieb) wird nur gezeigt.

use crate::data::{self, Paths};
use crate::py;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct Settings {
    /// Ordner fuer die Kursdateien
    pub ziel: String,
    /// mitgeliefert | entwickler
    pub mode: &'static str,
    /// Ordner mit Stand, Index und Vorschlaegen der Bruecke
    pub data: String,
    /// Der Ordner liegt in einem Obsidian-Tresor (dann gibt es die Notiz-Knoepfe)
    pub obsidian: bool,
}

/// Obsidian-Tresor = Ordner mit `.obsidian` ueber `ziel` (Kursbuch nimmt den Ordner ueber `ziel` als Tresor, siehe open.rs)
pub fn is_vault(ziel: &Path) -> bool {
    ziel.parent().is_some_and(|p| p.join(".obsidian").is_dir())
}

/// Ordner aus der Oberflaeche pruefen: absolut, nicht die Wurzel eines Laufwerks, nicht zu lang (Pfade im Ordner koennen bis ~100 Zeichen tiefer liegen)
pub fn valid_ziel(s: &str) -> Result<PathBuf, String> {
    let s = s.trim();
    let p = Path::new(s);
    if s.is_empty() || s.chars().count() > 150 || s.chars().any(char::is_control) || !p.is_absolute() || p.parent().is_none() {
        return Err("Der Ordner ist nicht verwendbar (voller Pfad, nicht die Wurzel eines Laufwerks, höchstens 150 Zeichen).".into());
    }
    if p.exists() && !p.is_dir() {
        return Err("Das ist eine Datei, kein Ordner.".into());
    }
    Ok(p.to_path_buf())
}

fn ziel_of(paths: &Paths) -> Result<PathBuf, String> {
    data::ziel(paths).or_else(|_| {
        // noch keine sync_config.json: die Bruecke legt sie mit dem Vorgabeordner an
        let out = py::cli(paths, &["config", "get", "ziel"], None)?;
        let v: serde_json::Value = py::last_json(&out).ok_or("Die Einstellungen ließen sich nicht lesen.")?;
        v["config"]["ziel"].as_str().map(PathBuf::from).ok_or_else(|| "Der Ordner für die Kursdateien ist nicht gesetzt.".to_string())
    })
}

pub fn get(paths: &Paths) -> Result<Settings, String> {
    let ziel = ziel_of(paths)?;
    Ok(Settings {
        obsidian: is_vault(&ziel),
        ziel: ziel.to_string_lossy().into_owned(),
        mode: if paths.bridge.is_some() { "mitgeliefert" } else { "entwickler" },
        data: paths.project.join("data").to_string_lossy().into_owned(),
    })
}

pub fn set_ziel(paths: &Paths, ziel: &str) -> Result<(), String> {
    let p = valid_ziel(ziel)?;
    let out = py::cli(paths, &["config", "set", "ziel", &p.to_string_lossy()], None)?;
    match py::last_json::<serde_json::Value>(&out) {
        Some(v) if v["ok"] == true => Ok(()),
        Some(v) => Err(v["error"].as_str().unwrap_or("Der Ordner ließ sich nicht speichern.").to_string()),
        None => Err("Der Ordner ließ sich nicht speichern.".into()),
    }
}

#[tauri::command]
pub async fn settings_get(paths: State<'_, Paths>) -> Result<Settings, String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get(&p)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn settings_set_ziel(paths: State<'_, Paths>, ziel: String) -> Result<(), String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_ziel(&p, &ziel)).await.map_err(|e| e.to_string())?
}

/// Den Ordner der Kursdateien im Explorer oeffnen (wird angelegt, falls es ihn noch nicht gibt)
#[tauri::command]
pub async fn open_ziel(app: AppHandle, paths: State<'_, Paths>) -> Result<(), String> {
    let p = paths.inner().clone();
    let ziel = tauri::async_runtime::spawn_blocking(move || ziel_of(&p)).await.map_err(|e| e.to_string())??;
    std::fs::create_dir_all(&ziel).map_err(|e| format!("Der Ordner ließ sich nicht anlegen: {e}"))?;
    app.opener().open_path(ziel.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_from_the_ui_are_checked() {
        for ok in [r"C:\Users\Jörg Müller\Documents\Kursbuch", r"D:\Second Brain\LearnWeb", r"\\server\share\Kurs"] {
            assert!(valid_ziel(ok).is_ok(), "{ok}");
        }
        assert_eq!(valid_ziel("  C:\\Kurse  ").unwrap(), PathBuf::from(r"C:\Kurse")); // Leerzeichen am Rand fallen weg
        for bad in ["", "   ", "relativ\\ordner", "-x", "--help", "C:\\", "C:\\a\nb", &format!("C:\\{}", "a".repeat(150))] {
            assert!(valid_ziel(bad).is_err(), "{bad:?}");
        }
        let file = std::env::temp_dir().join(format!("kursbuch-set-{}.txt", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        assert!(valid_ziel(&file.to_string_lossy()).unwrap_err().contains("Datei"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_vault_is_a_folder_with_dot_obsidian_above_the_target() {
        let root = std::env::temp_dir().join(format!("kursbuch-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Vault").join("LearnWeb")).unwrap();
        let ziel = root.join("Vault").join("LearnWeb");
        assert!(!is_vault(&ziel));
        std::fs::create_dir_all(root.join("Vault").join(".obsidian")).unwrap();
        assert!(is_vault(&ziel));
        assert!(!is_vault(Path::new("C:\\")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
