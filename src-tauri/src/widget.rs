//! Pomodoro-Widget: ein eigenes Fenster ohne Rahmen, durchsichtig, immer oben, das als Overlay ueber allem liegt (Label
//! `pomodoro`, Adresse `index.html?widget=pomodoro`). Den Timer fuehrt das Hauptfenster; das Widget zeigt ihn und schickt
//! Pause/Weiter/Stopp zurueck (Ereignisse, siehe widget.ts). Die Lage merkt sich das Widget selbst (localStorage) und
//! gibt sie beim naechsten Oeffnen mit.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "pomodoro";
const W: f64 = 250.0;
const H: f64 = 300.0;

/// Vorgabe: oben rechts auf dem Hauptmonitor, unter der Notch-Zone (logische Pixel)
fn default_pos(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            (m.position().x as f64 / s + m.size().width as f64 / s - W - 24.0, m.position().y as f64 / s + 70.0)
        })
        .unwrap_or((900.0, 70.0))
}

/// Auf dem Bildschirm halten: eine gemerkte Lage von einem frueheren, groesseren Bildschirm gilt nicht mehr
fn clamp(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    let Some(m) = app.primary_monitor().ok().flatten() else { return (x, y) };
    let s = m.scale_factor();
    let (mx, my, mw, mh) = (m.position().x as f64 / s, m.position().y as f64 / s, m.size().width as f64 / s, m.size().height as f64 / s);
    (x.clamp(mx, (mx + mw - 80.0).max(mx)), y.clamp(my, (my + mh - 80.0).max(my)))
}

/// `async`: Fenster entstehen auf einem Arbeitsthread (siehe windows.rs)
#[tauri::command]
pub async fn pomodoro_widget(app: AppHandle, show: bool, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if !show {
            let _ = w.close();
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }
    let (dx, dy) = default_pos(&app);
    let (px, py) = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => clamp(&app, x, y),
        _ => (dx, dy),
    };
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html?widget=pomodoro".into()))
        .title("Pomodoro")
        .inner_size(W, H)
        .position(px, py)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|e| format!("Das Widget ließ sich nicht öffnen: {e}"))?;
    Ok(())
}
