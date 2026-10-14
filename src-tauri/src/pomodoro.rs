//! Pomodoro in der Notch: Kursbuch fuehrt den Timer (Oberflaeche), die Notch zeigt ihn als eigene Live Activity
//! `kursbuch:pomodoro` (die Notch selbst wird nicht veraendert; `notch:` ist fuer ihren eingebauten Timer reserviert).
//! Ein Faden sendet die Karte jede Sekunde (Wert „24:13“, Balken) und holt Klicks auf „Pause“/„Weiter“/„Stopp“ ueber
//! `GET /events` ab; sie gehen als Ereignis `pomodoro-action` an die Oberflaeche. Laeuft die Notch nicht, passiert nichts.

use crate::data::Paths;
use crate::notch;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const ID: &str = "kursbuch:pomodoro";
const FOCUS: &str = "#ffb09b"; // Pfirsich wie in der Notch
const PAUSE: &str = "#8fdcbc"; // Mint

/// Stand des Timers aus Sicht der Oberflaeche
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Pomo {
    /// focus | short | long
    pub phase: String,
    /// running | paused | ready (Phase ist um, wartet auf den Start der naechsten)
    pub status: String,
    /// Ende der Phase (ms seit 1970), nur wenn sie laeuft
    #[serde(default)]
    pub ends_at: u64,
    /// verbleibende Sekunden (pausiert, bereit)
    #[serde(default)]
    pub left: u32,
    pub total: u32,
    #[serde(default)]
    pub task: String,
    pub round: u32,
    pub rounds: u32,
}

static STATE: Mutex<Option<Pomo>> = Mutex::new(None);
static STOP: AtomicBool = AtomicBool::new(false);
static ALERT: AtomicBool = AtomicBool::new(false);

fn clock(s: u64) -> String {
    format!("{}:{:02}", s / 60, s % 60)
}

fn ring(color: &str) -> String {
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='8' fill='none' stroke='{color}' stroke-width='2.4' opacity='.35'/><path d='M12 4a8 8 0 0 1 8 8' fill='none' stroke='{color}' stroke-width='2.4' stroke-linecap='round'/><circle cx='12' cy='12' r='2.6' fill='{color}'/></svg>"
    );
    let mut out = String::from("data:image/svg+xml;utf8,");
    for c in svg.chars() {
        match c {
            '%' => out.push_str("%25"),
            '#' => out.push_str("%23"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c => out.push(c),
        }
    }
    out
}

/// Karte fuer die Notch zum Zeitpunkt `now_ms`
pub fn activity(p: &Pomo, now_ms: u64, alert: bool) -> Value {
    let running = p.status == "running";
    let left_s = if running { p.ends_at.saturating_sub(now_ms).div_ceil(1000) } else { u64::from(p.left) };
    let color = if p.phase == "focus" { FOCUS } else { PAUSE };
    let title = match p.phase.as_str() {
        "focus" => "Fokus",
        "long" => "Lange Pause",
        _ => "Pause",
    };
    let mut sub = if p.task.is_empty() { format!("Runde {} von {}", p.round, p.rounds) } else { p.task.chars().take(60).collect() };
    match p.status.as_str() {
        "paused" => sub.push_str(" · pausiert"),
        "ready" => sub = format!("{} · bereit", if p.phase == "focus" { "Weiter fokussieren" } else { "Pause starten" }),
        _ => {}
    }
    let actions = match p.status.as_str() {
        "running" => json!([{"id": "pause", "label": "Pause", "icon": "pause"}, {"id": "stop", "label": "Stopp", "icon": "stop"}]),
        "paused" => json!([{"id": "resume", "label": "Weiter", "icon": "play"}, {"id": "stop", "label": "Stopp", "icon": "stop"}]),
        _ => json!([{"id": "start", "label": "Start", "icon": "play"}, {"id": "stop", "label": "Stopp", "icon": "stop"}]),
    };
    let progress = if p.total == 0 { 0.0 } else { (left_s as f64 / f64::from(p.total)).clamp(0.0, 1.0) };
    let mut v = json!({
        "id": ID, "app": "Kursbuch", "title": title, "subtitle": sub, "value": clock(left_s), "icon": ring(color), "color": color,
        "progress": progress, "ttl": 6, "priority": 8, "alert": alert, "open": "kursbuch://fokus", "actions": actions,
    });
    if running {
        v["ends_at"] = json!(p.ends_at);
    }
    v
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn push(paths: &Paths) {
    if !paths.notch {
        return;
    }
    let state = STATE.lock().unwrap().clone();
    if let Some(p) = state {
        let alert = ALERT.swap(false, Ordering::Relaxed);
        let _ = notch::request("POST", "/activity", &activity(&p, now_ms(), alert).to_string(), 400);
    }
}

/// Neuer Stand von der Oberflaeche (`None` = Timer beendet: Karte wegraeumen)
#[tauri::command]
pub fn pomodoro_notch(app: AppHandle, state: Option<Pomo>) {
    let paths = app.state::<Paths>();
    let mut cur = STATE.lock().unwrap();
    // beim Wechsel in „bereit“ klappt die Notch kurz auf (Phase ist um)
    if state.as_ref().is_some_and(|s| s.status == "ready") && cur.as_ref().map(|c| c.status.as_str()) != Some("ready") {
        ALERT.store(true, Ordering::Relaxed);
    }
    *cur = state.clone();
    drop(cur);
    if state.is_none() {
        if paths.notch {
            let _ = notch::request("DELETE", &format!("/activity/{ID}"), "", 400);
        }
    } else {
        push(&paths);
    }
}

/// Klicks auf die Knoepfe der Karte: `GET /events?after=N` liefert Eintraege mit `seq`, `activity`, `action`
fn actions(body: &str, after: &mut u64) -> Vec<String> {
    let list: Vec<Value> = body.split_once("\r\n\r\n").and_then(|(_, b)| serde_json::from_str(b).ok()).unwrap_or_default();
    let mut out = Vec::new();
    for e in list {
        *after = (*after).max(e["seq"].as_u64().unwrap_or(0));
        if e["activity"] == ID {
            if let Some(a) = e["action"].as_str().filter(|a| matches!(*a, "pause" | "resume" | "start" | "stop")) {
                out.push(a.to_string());
            }
        }
    }
    out
}

/// Eigener Faden: jede Sekunde die Karte senden, alle halbe Sekunde Klicks abholen (nur solange ein Timer laeuft)
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut after = 0u64;
        let mut tick = 0u32;
        // Ereignisse, die schon vor dem Start da waren, nicht nachtraeglich ausfuehren
        if let Ok(r) = notch::fetch("/events", 300) {
            let _ = actions(&r, &mut after);
        }
        while !STOP.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(500));
            if STATE.lock().unwrap().is_none() {
                continue;
            }
            let paths = app.state::<Paths>();
            if !paths.notch {
                continue;
            }
            if let Ok(r) = notch::fetch(&format!("/events?after={after}"), 300) {
                for a in actions(&r, &mut after) {
                    let _ = app.emit("pomodoro-action", a);
                }
            }
            tick += 1;
            if tick % 2 == 0 {
                push(&paths);
            }
        }
    });
}

/// Beim Beenden der App: Karte wegraeumen
pub fn shutdown() {
    STOP.store(true, Ordering::Relaxed);
    if STATE.lock().unwrap().take().is_some() {
        let _ = notch::request("DELETE", &format!("/activity/{ID}"), "", 400);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(status: &str, phase: &str) -> Pomo {
        Pomo { phase: phase.into(), status: status.into(), ends_at: 1_000_000 + 90_000, left: 300, total: 1500, task: String::new(), round: 2, rounds: 4 }
    }

    #[test]
    fn running_card_counts_down_from_ends_at_and_carries_the_countdown() {
        let a = activity(&p("running", "focus"), 1_000_000, false);
        assert_eq!((a["id"].as_str(), a["title"].as_str(), a["value"].as_str(), a["color"].as_str()), (Some(ID), Some("Fokus"), Some("1:30"), Some(FOCUS)));
        assert_eq!(a["ends_at"], 1_090_000);
        assert!((a["progress"].as_f64().unwrap() - 90.0 / 1500.0).abs() < 1e-9);
        assert_eq!(a["subtitle"], "Runde 2 von 4");
        assert_eq!(a["actions"][0]["id"], "pause");
        // eine Zehntelsekunde vor Schluss zeigt noch 0:01, danach 0:00
        assert_eq!(activity(&p("running", "focus"), 1_089_900, false)["value"], "0:01");
        assert_eq!(activity(&p("running", "focus"), 1_200_000, false)["value"], "0:00");
    }

    #[test]
    fn paused_and_ready_cards_hold_still_and_offer_the_right_buttons() {
        let a = activity(&p("paused", "short"), 5, false);
        assert_eq!((a["value"].as_str(), a["title"].as_str(), a["color"].as_str(), a.get("ends_at")), (Some("5:00"), Some("Pause"), Some(PAUSE), None));
        assert_eq!((a["actions"][0]["id"].as_str(), a["subtitle"].as_str()), (Some("resume"), Some("Runde 2 von 4 · pausiert")));
        let mut r = p("ready", "focus");
        r.task = "Kapitel 3".into();
        let a = activity(&r, 0, true);
        assert_eq!((a["actions"][0]["id"].as_str(), a["subtitle"].as_str(), a["alert"].as_bool()), (Some("start"), Some("Weiter fokussieren · bereit"), Some(true)));
        assert_eq!(activity(&p("paused", "long"), 0, false)["title"], "Lange Pause");
        let mut t = p("paused", "focus");
        t.total = 0;
        assert_eq!(activity(&t, 0, false)["progress"], 0.0); // keine Division durch null
    }

    #[test]
    fn long_task_names_are_cut_and_the_icon_is_a_data_url() {
        let mut t = p("running", "focus");
        t.task = "x".repeat(200);
        assert_eq!(activity(&t, 0, false)["subtitle"].as_str().unwrap().chars().count(), 60);
        let icon = activity(&t, 0, false)["icon"].as_str().unwrap().to_string();
        assert!(icon.starts_with("data:image/svg+xml;utf8,%3Csvg") && !icon.contains('#') && !icon.contains('<'));
    }

    #[test]
    fn only_known_actions_for_our_activity_are_taken_and_seq_advances() {
        let body = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[{\"seq\":7,\"activity\":\"kursbuch:pomodoro\",\"action\":\"pause\"},{\"seq\":8,\"activity\":\"anderes\",\"action\":\"stop\"},{\"seq\":9,\"activity\":\"kursbuch:pomodoro\",\"action\":\"rm -rf\"},{\"seq\":10,\"activity\":\"kursbuch:pomodoro\",\"action\":\"stop\"}]";
        let mut after = 0;
        assert_eq!(actions(body, &mut after), vec!["pause".to_string(), "stop".to_string()]);
        assert_eq!(after, 10);
        let mut a2 = 3;
        assert!(actions("", &mut a2).is_empty() && actions("HTTP/1.1 200 OK\r\n\r\nnicht json", &mut a2).is_empty());
        assert_eq!(a2, 3);
    }
}
