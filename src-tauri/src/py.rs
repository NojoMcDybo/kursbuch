//! Aufruf der Python-Seite (`uv run python -m learnweb.cli …` im Projektordner). Nur die Python-Seite spricht mit LearnWeb und
//! kennt die Zugangsdaten; die App bekommt die JSON-Antwort (letzte JSON-Zeile der Ausgabe).

use crate::data::Paths;
use serde::de::DeserializeOwned;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Befehl ausfuehren und die Ausgabe (stdout) zurueckgeben. `stdin` geht als eine Zeile an den Prozess (Passwoerter nie als Argument).
pub fn cli(paths: &Paths, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut child = Command::new(&paths.uv)
        .args(["run", "python", "-m", "learnweb.cli"])
        .args(args)
        .current_dir(&paths.project)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Die Python-Seite (uv) lässt sich nicht starten: {e}"))?;
    if let (Some(line), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Schreibfehler (Prozess schon beendet) zeigt sich unten an der Antwort; das Rohr schliesst beim Verlassen des Blocks
        let _ = pipe.write_all(line.as_bytes()).and_then(|_| pipe.write_all(b"\n"));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Befehl ausfuehren und jede Zeile der Ausgabe sofort melden (fuer den Sync mit Fortschritt); Rueckgabe: Exitcode
pub fn stream(paths: &Paths, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<i32, String> {
    use std::io::{BufRead, BufReader};
    let mut child = Command::new(&paths.uv)
        .args(["run", "python", "-m", "learnweb.cli"])
        .args(args)
        .current_dir(&paths.project)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Die Python-Seite (uv) lässt sich nicht starten: {e}"))?;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            on_line(&line);
        }
    }
    Ok(child.wait().map_err(|e| e.to_string())?.code().unwrap_or(-1))
}

/// Letzte Zeile der Ausgabe, die sich als `T` lesen laesst (davor koennen Warnungen stehen)
pub fn last_json<T: DeserializeOwned>(stdout: &str) -> Option<T> {
    stdout.lines().rev().find_map(|l| serde_json::from_str(l.trim()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_last_parsable_json_line() {
        let v: serde_json::Value = last_json("warn\n{\"a\": 1}\nnoise\n{\"a\": 2}\ntrailing text").unwrap();
        assert_eq!(v["a"], 2);
        assert!(last_json::<serde_json::Value>("").is_none());
        assert!(last_json::<serde_json::Value>("Traceback\n  boom").is_none());
    }
}
