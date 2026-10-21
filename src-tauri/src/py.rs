//! Aufruf der Python-Seite (`uv run python -m learnweb.cli …` im Projektordner, oder die mitgelieferte `learnweb-bridge.exe`, siehe data.rs; gleiche
//! Argumente, gleiche Antworten). Nur die Python-Seite spricht mit LearnWeb und
//! kennt die Zugangsdaten; die App bekommt die JSON-Antwort (letzte JSON-Zeile der Ausgabe). Einzige Ausnahme: eine Anmeldung
//! ohne „Passwort speichern“ haelt das Passwort bis zum Abmelden oder Beenden im Speicher (siehe `set_session`).

use crate::data::Paths;
use serde::de::DeserializeOwned;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// (Kennung, Passwort) einer Anmeldung ohne Speichern. Nur im Speicher dieses Prozesses, nie auf der Platte.
/// shortcut: wird beim Abmelden verworfen, aber nicht ueberschrieben (kein zeroize); bei Bedarf `zeroize` nehmen.
static SESSION: Mutex<Option<(String, String)>> = Mutex::new(None);

pub fn set_session(s: Option<(String, String)>) {
    *SESSION.lock().unwrap() = s;
}

pub fn session_user() -> Option<String> {
    SESSION.lock().unwrap().as_ref().map(|s| s.0.clone())
}

/// Befehle, die sich bei LearnWeb anmelden und dafuer das Passwort brauchen
fn needs_login(args: &[&str]) -> bool {
    matches!(args.first(), Some(&("sync" | "fetch" | "content")))
}

/// Grundbefehl. Mit Sitzungspasswort geht es als erste stdin-Zeile hinein (`--password-stdin`, nie als Argument oder in die
/// Umgebung), die Kennung ueber `LEARNWEB_USER`.
fn base(paths: &Paths, args: &[&str]) -> (Command, Option<String>) {
    let session = if needs_login(args) { SESSION.lock().unwrap().clone() } else { None };
    // mitgelieferte Bruecke: dasselbe Programm ohne uv; LEARNWEB_HOME sagt ihr, wo data/ und sync_config.json liegen
    let mut c = match &paths.bridge {
        Some(exe) => {
            let mut c = Command::new(exe);
            c.env("LEARNWEB_HOME", &paths.project);
            c
        }
        None => {
            let mut c = Command::new(&paths.uv);
            c.args(["run", "python", "-m", "learnweb.cli"]);
            c
        }
    };
    if session.is_some() {
        c.arg("--password-stdin");
    }
    c.args(args).current_dir(&paths.project).creation_flags(CREATE_NO_WINDOW);
    if let Some((user, _)) = &session {
        c.env("LEARNWEB_USER", user);
    }
    (c, session.map(|s| s.1))
}

/// Befehl ausfuehren und die Ausgabe (stdout) zurueckgeben. `stdin` geht als eine Zeile an den Prozess (Passwoerter nie als Argument).
pub fn cli(paths: &Paths, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let (mut cmd, pw) = base(paths, args);
    let line = pw.as_deref().or(stdin);
    let mut child = cmd
        .stdin(if line.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Die Python-Seite (uv) lässt sich nicht starten: {e}"))?;
    if let (Some(line), Some(mut pipe)) = (line, child.stdin.take()) {
        // Schreibfehler (Prozess schon beendet) zeigt sich unten an der Antwort; das Rohr schliesst beim Verlassen des Blocks
        let _ = pipe.write_all(line.as_bytes()).and_then(|_| pipe.write_all(b"\n"));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Befehl ausfuehren und jede Zeile der Ausgabe sofort melden (fuer den Sync mit Fortschritt); Rueckgabe: Exitcode
pub fn stream(paths: &Paths, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<i32, String> {
    use std::io::{BufRead, BufReader};
    let (mut cmd, pw) = base(paths, args);
    let mut child = cmd
        .stdin(if pw.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Die Python-Seite (uv) lässt sich nicht starten: {e}"))?;
    if let (Some(line), Some(mut pipe)) = (pw, child.stdin.take()) {
        let _ = pipe.write_all(line.as_bytes()).and_then(|_| pipe.write_all(b"\n")); // das Rohr schliesst hier
    }
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
    use std::ffi::OsStr;

    fn paths() -> Paths {
        Paths { project: "x".into(), uv: "uv.exe".into(), config: "x".into(), notch: false, bridge: None }
    }

    fn args(c: &Command) -> Vec<String> {
        c.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn bundled_bridge_is_called_directly_with_the_data_folder_in_the_environment() {
        let mut p = paths();
        p.project = r"C:\Users\Jörg Müller\bridge".into();
        p.bridge = Some(r"C:\Programme\Kursbuch\bridge\learnweb-bridge.exe".into());
        let (c, _) = base(&p, &["status"]);
        assert!(c.get_program().to_string_lossy().ends_with("learnweb-bridge.exe") && args(&c) == ["status"]); // kein uv, kein python -m
        assert!(c.get_envs().any(|(k, v)| k == OsStr::new("LEARNWEB_HOME") && v == Some(OsStr::new(&p.project))));
        p.bridge = None;
        let (c, _) = base(&p, &["status"]); // Entwickler-Betrieb wie bisher
        assert!(c.get_program().to_string_lossy().ends_with("uv.exe") && args(&c) == ["run", "python", "-m", "learnweb.cli", "status"]);
    }

    #[test]
    fn takes_the_last_parsable_json_line() {
        let v: serde_json::Value = last_json("warn\n{\"a\": 1}\nnoise\n{\"a\": 2}\ntrailing text").unwrap();
        assert_eq!(v["a"], 2);
        assert!(last_json::<serde_json::Value>("").is_none());
        assert!(last_json::<serde_json::Value>("Traceback\n  boom").is_none());
    }

    #[test]
    fn only_commands_that_log_in_get_the_session_password() {
        for (a, yes) in [("sync", true), ("fetch", true), ("content", true), ("status", false), ("login", false), ("logout", false), ("schedule", false)] {
            assert_eq!(needs_login(&[a]), yes, "{a}");
        }
        assert!(!needs_login(&[]));
    }

    /// Die Sitzung ist ein Prozess-Zustand: alles in einem Test, damit nichts parallel daran dreht
    #[test]
    fn session_password_goes_in_by_stdin_never_by_argument_or_environment() {
        set_session(None);
        let (c, pw) = base(&paths(), &["sync", "--json"]);
        assert!(pw.is_none() && !args(&c).contains(&"--password-stdin".to_string()) && c.get_envs().all(|(k, _)| k != OsStr::new("LEARNWEB_USER")));

        set_session(Some(("abc".into(), "geheim".into())));
        assert_eq!(session_user().as_deref(), Some("abc"));
        let (c, pw) = base(&paths(), &["sync", "--json"]);
        assert_eq!(pw.as_deref(), Some("geheim"));
        let a = args(&c);
        assert!(a.contains(&"--password-stdin".to_string()) && !a.iter().any(|x| x.contains("geheim")));
        assert!(c.get_envs().all(|(_, v)| v != Some(OsStr::new("geheim")))); // nur die Kennung steht in der Umgebung
        assert!(c.get_envs().any(|(k, v)| k == OsStr::new("LEARNWEB_USER") && v == Some(OsStr::new("abc"))));
        let (c, pw) = base(&paths(), &["status"]); // Befehle ohne Anmeldung bekommen nichts
        assert!(pw.is_none() && !args(&c).contains(&"--password-stdin".to_string()));

        set_session(None);
        assert!(session_user().is_none());
    }
}
