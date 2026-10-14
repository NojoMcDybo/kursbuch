//! Kurse oeffnen in einem eigenen Fenster (`kurs-<id>`): ein zweiter Klick auf denselben Kurs holt das Fenster nach vorn
//! und laesst es die gewuenschte Stelle zeigen. Die Oberflaeche nennt nur die Kurs-ID (und optional Aktivitaet oder Abschnitt).

use crate::data::{self, Paths};
use crate::model::split_name;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Stelle im Kurs, die das Fenster zeigen soll
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Target {
    pub cmid: Option<i64>,
    pub section: Option<String>,
}

pub fn label(course: i64) -> String {
    format!("kurs-{course}")
}

/// Adresse der Kursseite innerhalb der App (die Oberflaeche liest die Parameter)
pub fn url(course: i64, t: &Target) -> String {
    let mut u = format!("index.html?kurs={course}");
    if let Some(id) = t.cmid {
        u += &format!("&cmid={id}");
    }
    if let Some(s) = &t.section {
        u += &format!("&sec={}", utf8_percent_encode(s, NON_ALPHANUMERIC));
    }
    u
}

/// `async`: Fenster entstehen auf einem Arbeitsthread; ein synchroner Befehl liefe auf dem Hauptthread und liesse die Erstellung
/// unter Windows haengen (das neue Fenster bliebe leer).
#[tauri::command]
pub async fn open_course(app: AppHandle, paths: State<'_, Paths>, course: i64, cmid: Option<i64>, section: Option<String>) -> Result<(), String> {
    let s = data::state(&paths)?;
    let c = data::course(&s, course)?;
    let t = Target { cmid, section: section.filter(|s| !s.is_empty() && s.len() <= 300) };
    let id = label(course);
    if let Some(w) = app.get_webview_window(&id) {
        let _ = app.emit_to(&id, "reveal", t);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, &id, WebviewUrl::App(url(course, &t).into()))
        .title(split_name(&c.name).title)
        .inner_size(1100.0, 900.0)
        .maximized(true) // „Vollbild“: das Kursfenster fuellt den Bildschirm (ohne Leiste)
        .min_inner_size(520.0, 480.0)
        .decorations(false)
        .background_color(Color(28, 28, 30, 255))
        .center()
        .build()
        .map_err(|e| format!("Das Fenster ließ sich nicht öffnen: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_carries_only_encoded_parameters() {
        assert_eq!(url(7, &Target::default()), "index.html?kurs=7");
        assert_eq!(url(7, &Target { cmid: Some(42), section: None }), "index.html?kurs=7&cmid=42");
        let u = url(7, &Target { cmid: None, section: Some("12 October: Intro & \"x\"=1#y".into()) });
        assert_eq!(u, "index.html?kurs=7&sec=12%20October%3A%20Intro%20%26%20%22x%22%3D1%23y");
        assert_eq!(label(93434), "kurs-93434");
    }
}
