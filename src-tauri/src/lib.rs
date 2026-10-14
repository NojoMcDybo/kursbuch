//! Kursbuch — LearnWeb-Kurse, Fristen und Suche im Nojo-Oekosystem.
//!
//! - model.rs:  Datenvertrag mit der Python-Seite (State, Konfiguration), Kursnamen zerlegen
//! - data.rs:   State lesen (zwischengespeichert), Kursraster und Kursansicht bauen
//! - events.rs: Termine (LearnWeb-Fristen + Sitzungen/Fristen aus Abschnittstiteln und Labels)
//! - colors.rs: feste Kursfarben
//! - visits.rs: „Neu seit dem letzten Oeffnen“
//! - notch.rs:  Lage der Notch (die Oberflaeche weicht aus) und die Karte „naechste Frist“
//! - open.rs:   Dateien (PDF -> Folio), Links, Obsidian-Notiz und Ordner oeffnen; nur IDs von der Oberflaeche
//! - links.rs:  Deep Link kursbuch://heute | kurs/<id> | suche/<Begriff> (nur navigieren)
//!
//! Die App kennt keine Passwoerter und spricht nie mit LearnWeb: Nur die Python-Seite (learnweb-mcp) tut das.

mod colors;
mod data;
mod events;
mod links;
mod model;
mod notch;
mod open;
mod visits;

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Link aus einem Deep Link, bis das Fenster ihn abholt
static PENDING: Mutex<Option<links::Link>> = Mutex::new(None);

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    for u in urls {
        if let Some(l) = links::parse(&u) {
            *PENDING.lock().unwrap() = Some(l.clone());
            let _ = app.emit("open-link", l);
        }
    }
    show(app);
}

/// Link, der per Deep Link geoeffnet werden soll (einmal abholen)
#[tauri::command]
fn take_pending() -> Option<links::Link> {
    PENDING.lock().unwrap().take()
}

#[tauri::command]
fn overview(paths: tauri::State<data::Paths>) -> data::Overview {
    data::overview(&paths)
}

#[tauri::command]
fn course(paths: tauri::State<data::Paths>, id: i64) -> Result<data::CourseView, String> {
    data::course_view(&paths, id)
}

#[tauri::command]
fn events(paths: tauri::State<data::Paths>) -> Vec<events::Event> {
    events::load(&paths)
}

#[tauri::command]
fn news(paths: tauri::State<data::Paths>, visits: tauri::State<visits::Visits>) -> Result<Vec<visits::NewItem>, String> {
    visits::news(&paths, &visits)
}

#[tauri::command]
fn mark_read(visits: tauri::State<visits::Visits>) {
    visits.mark_read();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Nur ein Kursbuch; ein zweiter Start (z. B. Deep Link aus der Notch) holt das laufende nach vorn
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_links(app, args.into_iter().filter(|a| a.to_ascii_lowercase().starts_with("kursbuch://")));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            overview,
            course,
            events,
            news,
            mark_read,
            take_pending,
            notch::notch_rect,
            open::open_file,
            open::open_web,
            open::open_note,
            open::open_folder,
        ])
        .setup(|app| {
            let h = app.handle().clone();
            let paths = data::Paths::load(&h);
            h.manage(visits::Visits::load(&paths));
            h.manage(paths);
            notch::spawn(h.clone());
            // Schema kursbuch:// fuer diesen Benutzer anmelden (der Installer tut es auch; so klappt es auch im Test)
            #[cfg(desktop)]
            let _ = app.deep_link().register_all();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(l) = urls.iter().find_map(|u| links::parse(u.as_str())) {
                    *PENDING.lock().unwrap() = Some(l);
                }
            }
            let h2 = h.clone();
            app.deep_link().on_open_url(move |e| open_links(&h2, e.urls().into_iter().map(|u| u.to_string())));
            show(&h);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Kursbuch konnte nicht starten")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                notch::shutdown(); // Karte in der Notch wegraeumen
            }
        });
}
