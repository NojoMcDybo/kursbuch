//! Kleine JSON-Ablage im App-Ordner (Stundenplan, Fokus): atomar schreiben (Nebendatei, dann umbenennen) und eine Datei, die sich
//! nicht lesen laesst, beiseitelegen (`<name>.defekt`), statt sie von der naechsten Speicherung still zu ueberschreiben.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Inhalt der Datei; `None`, wenn es sie nicht gibt; Fehler, wenn sie sich nicht lesen laesst
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Wie `read`, aber eine unlesbare Datei wird beiseitegelegt und gilt als nicht vorhanden (fuer den Weg zum Speichern)
pub fn read_or_quarantine<T: DeserializeOwned>(path: &Path) -> Option<T> {
    match read(path) {
        Ok(v) => v,
        Err(_) => {
            let mut bad = path.as_os_str().to_owned();
            bad.push(".defekt");
            let _ = std::fs::rename(path, PathBuf::from(bad));
            None
        }
    }
}

pub fn write<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_is_none_broken_is_quarantined_and_writes_are_whole() {
        let dir = std::env::temp_dir().join(format!("kursbuch-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f = dir.join("sub").join("a.json");
        assert_eq!(read::<Vec<u32>>(&f).unwrap(), None);
        write(&f, &vec![1u32, 2, 3]).unwrap();
        assert_eq!(read::<Vec<u32>>(&f).unwrap(), Some(vec![1, 2, 3]));
        assert!(!f.with_extension("json.tmp").exists());
        std::fs::write(&f, b"{kaputt").unwrap();
        assert!(read::<Vec<u32>>(&f).is_err());
        assert_eq!(read_or_quarantine::<Vec<u32>>(&f), None);
        assert!(!f.exists() && f.with_extension("json.defekt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
