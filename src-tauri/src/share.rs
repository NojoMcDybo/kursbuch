//! „Fuer KI kopieren“: Verzeichnis (_Verzeichnis.md, von der Python-Seite gebaut) und Kurstext aus dem Index als ein Block
//! Markdown fuer Claude oder ChatGPT; dazu eine Datei als Datei in die Zwischenablage (zum Einfuegen als Anhang).

use crate::data::{self, Paths};
use crate::open;
use crate::search;
use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use tauri::State;

/// Obergrenze fuer „Uebersicht + Text“ (grob 100k Token); ein Kurs ist meist weit darunter
const MAX_CHARS: usize = 400_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct Outline {
    pub text: String,
    pub chars: usize,
    pub truncated: bool,
}

/// Abschnitt eines Kurses aus _Verzeichnis.md: von „### Titel“ bis zur naechsten „##“/„###“-Zeile. Erkannt an
/// „Kurs-ID <id>“ in der Zeile unter der Ueberschrift.
pub fn slice_course(md: &str, id: i64) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    let tag = format!("Kurs-ID {id}");
    let start = (0..lines.len()).find(|&i| lines[i].starts_with("### ") && lines.get(i + 2).is_some_and(|l| l.ends_with(&tag)))?;
    let end = (start + 1..lines.len()).find(|&j| lines[j].starts_with("## ") || lines[j].starts_with("### ")).unwrap_or(lines.len());
    Some(lines[start..end].join("\n").trim_end().to_string() + "\n")
}

fn directory(paths: &Paths) -> Result<String, String> {
    let ziel = data::ziel(paths)?;
    std::fs::read_to_string(ziel.join("_Verzeichnis.md")).map_err(|_| "Das Verzeichnis gibt es noch nicht (nach dem nächsten Sync).".to_string())
}

/// Ohne `course` das ganze Verzeichnis, sonst ein Kurs; `with_text` haengt den Text aller Dateien des Kurses an
pub fn outline(paths: &Paths, course: Option<i64>, with_text: bool) -> Result<Outline, String> {
    let md = directory(paths)?;
    let Some(id) = course else {
        // unveraendert: der Kopf des Verzeichnisses erklaert der KI den Aufbau
        return Ok(Outline { chars: md.chars().count(), text: md, truncated: false });
    };
    let part = slice_course(&md, id).ok_or("Der Kurs steht noch nicht im Verzeichnis (nach dem nächsten Sync).")?;
    let mut text = format!(
        "# LearnWeb-Kurs (Auszug aus dem Verzeichnis)\n\nPfade sind relativ zum LearnWeb-Ordner. „Text: leer“ = gescannte Datei ohne lesbaren Text; „zu groß“ = nur in LearnWeb.\n\n{part}"
    );
    let mut truncated = false;
    if with_text {
        let t = search::course_text(paths, id, MAX_CHARS)?;
        truncated = t.truncated;
        text.push_str("\n---\n\n# Text der Dateien\n\n");
        text.push_str(&t.text);
        if t.truncated {
            text.push_str("\n\n[… gekürzt, der Kurs hat mehr Text]\n");
        }
    }
    Ok(Outline { chars: text.chars().count(), text, truncated })
}

/// Eigener Thread: der Kurstext kommt aus dem Index und kann gross sein
#[tauri::command]
pub async fn for_ai(paths: State<'_, Paths>, course: Option<i64>, with_text: bool) -> Result<Outline, String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || outline(&p, course, with_text)).await.map_err(|e| e.to_string())?
}

/// Datei als Datei in die Zwischenablage (Einfuegen im Explorer oder als Anhang im Chat). Pfad kommt aus dem State und
/// wird wie beim Oeffnen geprueft; er geht per Umgebungsvariable an PowerShell, nie in den Befehlstext.
#[tauri::command]
pub async fn copy_file(paths: State<'_, Paths>, course: i64, cmid: i64, idx: usize) -> Result<(), String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || clipboard_file(&p, course, cmid, idx)).await.map_err(|e| e.to_string())?
}

fn clipboard_file(paths: &Paths, course: i64, cmid: i64, idx: usize) -> Result<(), String> {
    let s = data::state(paths)?;
    let c = data::course(&s, course)?;
    let rel = c.cms.get(&cmid.to_string()).ok_or("Aktivität nicht gefunden.")?.files.get(idx).ok_or("Datei nicht gefunden.")?;
    let file = open::resolve(&data::ziel(paths)?, rel)?;
    let st = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:KURSBUCH_COPY"])
        .env("KURSBUCH_COPY", &file)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Zwischenablage nicht erreichbar: {e}"))?;
    if st.success() { Ok(()) } else { Err("Die Datei ließ sich nicht kopieren.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MD: &str = "# V\n\n## WiSe 2026/27\n\n### Kurs A — Dozentin\n\n[LearnWeb](u) · Kurs-ID 7\n\n**Woche 1**\n- a\n\n### Kurs B\n\nKurs-ID 17\n\n**W**\n- b\n\n## SoSe 2026\n\n### Kurs C\n\nKurs-ID 70\n- c\n";

    #[test]
    fn slices_exactly_one_course() {
        let a = slice_course(MD, 7).unwrap();
        assert!(a.starts_with("### Kurs A — Dozentin\n") && a.contains("- a") && !a.contains("Kurs B") && a.ends_with("- a\n"));
        let b = slice_course(MD, 17).unwrap();
        assert!(b.contains("- b") && !b.contains("- a") && !b.contains("Kurs C"));
        assert!(slice_course(MD, 70).unwrap().ends_with("- c\n")); // letzter Kurs der Datei
        assert!(slice_course(MD, 1).is_none() && slice_course(MD, 777).is_none()); // „7“ ist nicht „17“ oder „70“
        assert!(slice_course("", 7).is_none());
    }
}
