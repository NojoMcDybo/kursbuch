//! Selbst-Update ueber GitHub Releases (wie in Arena und der Notch; NojoMcDybo/kursbuch): prueft 20 s nach dem Start und dann alle 6 h,
//! auf Wunsch sofort (Einstellungen › App). Installiert wird nur, was mit dem Schluessel aus tauri.conf.json
//! (plugins.updater.pubkey) signiert ist; das erledigt das Updater-Plugin. Zustand geht als Ereignis "update"
//! ans Fenster (Punkt am Konto-Kreis, Karte im Konto-Menue).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// laeuft gerade ein Download/Installation -> keine weiteren Pruefungen
static BUSY: AtomicBool = AtomicBool::new(false);
static STATE: Mutex<Option<Value>> = Mutex::new(None);

fn set(app: &AppHandle, v: Value) {
    let mut v = v;
    v["current"] = app.package_info().version.to_string().into();
    *STATE.lock().unwrap() = Some(v.clone());
    let _ = app.emit("update", v);
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            tauri::async_runtime::block_on(check(&app, false));
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

/// `manual`: auch Fehler zeigen; beim automatischen Pruefen (offline o. Ae.) still bleiben
async fn check(app: &AppHandle, manual: bool) -> Value {
    if BUSY.load(Ordering::SeqCst) {
        return state(app.clone());
    }
    if manual {
        set(app, json!({ "status": "checking" }));
    }
    let res = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(Some(u)) => set(app, json!({ "status": "available", "version": u.version })),
        Ok(None) => set(app, json!({ "status": "current" })),
        Err(e) if manual => set(app, json!({ "status": "error", "message": e })),
        Err(e) => eprintln!("[kursbuch] Update-Pruefung: {e}"),
    }
    state(app.clone())
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> Value {
    state(app)
}

fn state(app: AppHandle) -> Value {
    STATE.lock().unwrap().clone().unwrap_or_else(|| json!({ "status": "idle", "current": app.package_info().version.to_string() }))
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    check(&app, true).await
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    set(&app, json!({ "status": "downloading" }));
    let res: Result<(), String> = async {
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Kein Update mehr verfügbar")?;
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())
    }
    .await;
    match res {
        // Windows: der Installer beendet Kursbuch selbst und startet sie danach neu
        Ok(()) => app.restart(),
        Err(e) => {
            BUSY.store(false, Ordering::SeqCst);
            set(&app, json!({ "status": "error", "message": e }));
            Err(e)
        }
    }
}
