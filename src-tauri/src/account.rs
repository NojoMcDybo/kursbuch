//! Konto: Anmeldung bei LearnWeb ueber die Python-Seite. Die Zugangsdaten liegen in der Windows-Anmeldeinformationsverwaltung
//! (keyring), nie in einer Datei: das Passwort geht per stdin an `learnweb.cli login`, das es bei LearnWeb prueft und erst bei
//! Erfolg speichert. Ohne „Passwort speichern“ prueft es nur; die App haelt es dann bis zum Abmelden oder Beenden im Speicher
//! (py.rs) und reicht es den Syncs durch. Der Tresor (und damit geplanter Sync und MCP-Server) bleibt dabei unberuehrt.

use crate::data::Paths;
use crate::py;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Account {
    pub saved: bool,
    pub user: Option<String>,
    pub running: bool,
    /// angemeldet ohne gespeichertes Passwort (gilt nur, solange die App laeuft)
    #[serde(default)]
    pub session: bool,
}

#[derive(Deserialize)]
struct Status {
    #[serde(default)]
    running: bool,
    login: Login,
}

#[derive(Deserialize)]
struct Login {
    saved: bool,
    user: Option<String>,
}

/// Kennung wie „n_beis01“ oder „a.b@uni-muenster.de“: kein fuehrendes Minus (Option fuer die CLI), keine Leerzeichen
pub fn valid_user(u: &str) -> bool {
    let mut c = u.chars();
    c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && u.len() <= 64 && u.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c))
}

pub fn status(paths: &Paths) -> Result<Account, String> {
    let s: Status = py::last_json(&py::cli(paths, &["status"], None)?).ok_or("Der Kontostatus ließ sich nicht lesen.")?;
    Ok(match py::session_user() {
        Some(user) => Account { saved: true, user: Some(user), running: s.running, session: true },
        None => Account { saved: s.login.saved, user: s.login.user, running: s.running, session: false },
    })
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

fn reply(out: &str, fallback: &str) -> Result<(), String> {
    match py::last_json::<Reply>(out) {
        Some(r) if r.ok => Ok(()),
        Some(r) => Err(r.error.unwrap_or_else(|| fallback.into())),
        None => Err(fallback.into()),
    }
}

/// Prueft die Anmeldung bei LearnWeb und speichert sie dann (`save`) oder merkt sie nur fuer diese Sitzung; ein falsches
/// Passwort ueberschreibt nichts
pub fn login(paths: &Paths, user: &str, password: &str, save: bool) -> Result<(), String> {
    if !valid_user(user) {
        return Err("Die Kennung ist ungültig.".into());
    }
    if password.is_empty() || password.contains(['\n', '\r']) {
        return Err("Das Passwort fehlt.".into());
    }
    let args: &[&str] = if save { &["login", user] } else { &["login", user, "--no-save"] };
    reply(&py::cli(paths, args, Some(password))?, "Die Anmeldung ist fehlgeschlagen.")?;
    py::set_session((!save).then(|| (user.to_string(), password.to_string())));
    Ok(())
}

#[tauri::command]
pub async fn account_status(paths: State<'_, Paths>) -> Result<Account, String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status(&p)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn account_login(paths: State<'_, Paths>, user: String, password: String, save: bool) -> Result<(), String> {
    let p = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || login(&p, user.trim(), &password, save)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn account_logout(paths: State<'_, Paths>) -> Result<(), String> {
    let p = paths.inner().clone();
    py::set_session(None); // Abmelden vergisst auch ein nur im Speicher gehaltenes Passwort
    tauri::async_runtime::spawn_blocking(move || reply(&py::cli(&p, &["logout"], None)?, "Das Abmelden ist fehlgeschlagen.")).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_names_cannot_smuggle_options_or_spaces() {
        for ok in ["n_beis01", "a.b@uni-muenster.de", "X1", "a-b"] {
            assert!(valid_user(ok), "{ok}");
        }
        for bad in ["", "-x", "--help", "a b", "a\nb", "ä", "a;b", "$(x)", &"a".repeat(65), "_x"] {
            assert!(!valid_user(bad), "{bad:?}");
        }
    }

    #[test]
    fn replies_map_to_messages() {
        assert!(reply("{\"ok\": true, \"user\": \"a\"}", "x").is_ok());
        assert_eq!(reply("{\"ok\": false, \"error\": \"Ungültige Anmeldedaten\"}", "x").unwrap_err(), "Ungültige Anmeldedaten");
        assert_eq!(reply("{\"ok\": false}", "Fallback").unwrap_err(), "Fallback");
        assert_eq!(reply("Traceback", "Fallback").unwrap_err(), "Fallback");
    }

    #[test]
    fn rejects_bad_input_before_any_process_starts() {
        let p = Paths { project: "x".into(), uv: "gibt-es-nicht.exe".into(), config: "x".into(), notch: false, bridge: None };
        assert_eq!(login(&p, "-x", "pw", true).unwrap_err(), "Die Kennung ist ungültig.");
        assert_eq!(login(&p, "abc", "", false).unwrap_err(), "Das Passwort fehlt.");
        assert_eq!(login(&p, "abc", "a\nb", true).unwrap_err(), "Das Passwort fehlt.");
        assert!(login(&p, "abc", "pw", false).unwrap_err().contains("uv")); // gueltig: der Start scheitert erst am fehlenden Programm
    }
}
