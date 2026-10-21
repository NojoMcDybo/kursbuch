//! Notch (eigene App, D:\Dev\notch, http://127.0.0.1:47800): Wo sie sitzt (damit die Oberflaeche ihr ausweicht,
//! wie Arena) und die Karte „naechste Frist“ als Live Activity. Nur Rust, nur Loopback; laeuft die Notch nicht,
//! passiert nichts (kurzer Timeout, kein Fehler). Die Notch selbst wird nicht veraendert.

use crate::data::Paths;
use crate::events::{self, Event};
use crate::{colors, model, visits};
use chrono::{Local, TimeZone};
use serde::Serialize;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ID: &str = "kursbuch:frist";
/// Kursbuch-Symbol aus der gemeinsamen Bibliothek (src/nojo/icons, Quelle nojo-design/assets/icons.mjs)
const ICON_SVG: &str = include_str!("../../src/nojo/icons/kursbuch.svg");

static SENT: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);

pub fn request(method: &str, path: &str, body: &str, ms: u64) -> std::io::Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 47800));
    let t = Duration::from_millis(ms);
    let mut s = TcpStream::connect_timeout(&addr, t)?;
    s.set_read_timeout(Some(t))?;
    s.set_write_timeout(Some(t))?;
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    let mut buf = [0u8; 128];
    let n = s.read(&mut buf).unwrap_or(0);
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// GET mit der ganzen Antwort (Kopf und Rumpf, hoechstens 64 KB): fuer Listen wie /events
pub fn fetch(path: &str, ms: u64) -> std::io::Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 47800));
    let t = Duration::from_millis(ms);
    let mut s = TcpStream::connect_timeout(&addr, t)?;
    s.set_read_timeout(Some(t))?;
    s.set_write_timeout(Some(t))?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut out = Vec::new();
    s.take(64 * 1024).read_to_end(&mut out)?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn running() -> bool {
    request("GET", "/health", "", 150).is_ok_and(|r| r.contains(" 200 "))
}

// --------------------------------------------------------------------------- Lage der Notch

/// Wo die Notch liegt, in logischen Pixeln relativ zur Innenflaeche dieses Fensters. Sie sitzt am Hauptmonitor oben
/// in der Mitte (bzw. links/rechts, Notch-config.json „dock“); als Flaeche gilt ihre kompakte Form samt Ohren
/// (340 x 34, seitlich 44 x 280 — notch/src/main.ts SIZE/SIDE). Laeuft die Notch nicht: None.
#[derive(Serialize)]
pub struct NotchRect {
    dock: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[tauri::command]
pub fn notch_rect(app: AppHandle, window: tauri::WebviewWindow) -> Option<NotchRect> {
    if !running() {
        return None;
    }
    let cfg = app.path().app_data_dir().ok()?.parent()?.join("de.nojo.notch").join("config.json");
    let v: serde_json::Value = std::fs::read(cfg).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let dock = match v["dock"].as_str() {
        Some(d @ ("left" | "right")) => d,
        _ => "top",
    };
    let m = window.primary_monitor().ok()??;
    let ms = m.scale_factor();
    let (mx, my) = (m.position().x as f64, m.position().y as f64);
    let (mw, mh) = (m.size().width as f64, m.size().height as f64);
    let (w, h) = if dock == "top" { (340.0 * ms, 34.0 * ms) } else { (44.0 * ms, 280.0 * ms) };
    let (x, y) = match dock {
        "left" => (mx, my + (mh - h) / 2.0),
        "right" => (mx + mw - w, my + (mh - h) / 2.0),
        _ => (mx + (mw - w) / 2.0, my),
    };
    let p = window.inner_position().ok()?;
    let s = window.scale_factor().ok()?;
    Some(NotchRect { dock: dock.into(), x: (x - p.x as f64) / s, y: (y - p.y as f64) / s, w: w / s, h: h / s })
}

// --------------------------------------------------------------------------- Karte „naechste Frist“

/// Die naechste Frist oder Pruefung (bis 12 Stunden nach dem Termin noch sichtbar)
fn pick(events: &[Event], now: i64) -> Option<&Event> {
    events.iter().filter(|e| matches!(e.kind.as_str(), "frist" | "pruefung") && e.ts >= now - 12 * 3600).min_by_key(|e| e.ts)
}

/// Kalendertage von `now` bis `ts` in Ortszeit (wie die Oberflaeche zaehlt: Donnerstag 23:55 ist von Montag aus „3 Tage“ weg)
fn calendar_days(now: i64, ts: i64) -> i64 {
    let day = |t: i64| Local.timestamp_opt(t, 0).single().map(|d| d.date_naive()).unwrap_or_default();
    (day(ts) - day(now)).num_days()
}

/// Wert und Einheit der Notch-Zeile: „3“ „Tage“, „heute“, „5“ „Std“, „12“ „Min“, „ueberfaellig“
/// (gleiche Regeln wie `left()` in der Oberflaeche, src/dates.ts)
fn countdown(now: i64, ts: i64, all_day: bool) -> (String, &'static str) {
    let days = calendar_days(now, ts);
    if !all_day && ts < now {
        ("überfällig".into(), "")
    } else if days < 0 {
        ("vorbei".into(), "")
    } else if days == 0 && all_day {
        ("heute".into(), "")
    } else if days == 0 {
        let d = ts - now;
        if d < 3600 { (((d + 59) / 60).to_string(), "Min") } else { (((d + 3599) / 3600).to_string(), "Std") }
    } else {
        (days.to_string(), "Tage")
    }
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end())
    }
}

/// Symbol als data:-URL in der Farbe des Kurses (Helio macht es ebenso)
fn icon(color: &str) -> String {
    let svg = ICON_SVG.trim().replace("currentColor", color);
    let mut out = String::from("data:image/svg+xml;utf8,");
    for c in svg.chars() {
        match c {
            '%' => out.push_str("%25"),
            '#' => out.push_str("%23"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '"' => out.push('\''),
            '\n' | '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn card(e: &Event, now: i64, course: Option<(&str, u16)>) -> serde_json::Value {
    let (value, unit) = countdown(now, e.ts, e.all_day);
    let hours = (e.ts - now) as f64 / 3600.0;
    // Farbe traegt Information: ueberfaellig rot, unter 48 Stunden bernstein, sonst die Kursfarbe
    let color = if e.ts < now { "#ff453a".to_string() } else if hours < 48.0 { "#ffb340".to_string() } else { course.map_or("#bf5af2".to_string(), |c| colors::hex(c.1)) };
    let title = match course {
        Some((name, _)) => format!("{} · {}", short(name, 22), short(&e.short, 36)),
        None => short(&e.short, 60),
    };
    json!({
        "id": ID, "app": "Kursbuch", "title": if e.kind == "pruefung" { "Nächste Prüfung" } else { "Nächste Frist" },
        "subtitle": title, "value": value, "unit": unit, "icon": icon(&color), "color": color,
        "ttl": 120, "open": "kursbuch://heute",
    })
}

fn tick(app: &AppHandle) {
    let paths = app.state::<Paths>();
    if !paths.notch {
        if SENT.swap(false, Ordering::Relaxed) {
            let _ = request("DELETE", &format!("/activity/{ID}"), "", 400);
        }
        return;
    }
    let now = visits::now();
    let ev: Vec<Event> = events::load(&paths).into_iter().filter(|e| !e.suggested).collect(); // unbestaetigte Vorschlaege gehoeren nicht in die Notch
    let state = crate::data::state(&paths).ok();
    let body = pick(&ev, now).map(|e| {
        let course = e.course.and_then(|id| {
            let rec = state.as_ref()?.courses.get(&id.to_string())?;
            Some((model::split_name(&rec.name).title, colors::hues(&paths, &[id]).get(&id).copied().unwrap_or(283)))
        });
        card(e, now, course.as_ref().map(|(n, h)| (n.as_str(), *h))).to_string()
    });
    match body {
        Some(b) => {
            if request("POST", "/activity", &b, 400).is_ok() {
                SENT.store(true, Ordering::Relaxed);
            }
        }
        None => {
            if SENT.swap(false, Ordering::Relaxed) {
                let _ = request("DELETE", &format!("/activity/{ID}"), "", 400);
            }
        }
    }
}

/// Eigener Faden: jede Minute aus den lokalen Daten neu (die Karte hat `ttl` 120 s, verschwindet also von selbst)
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        tick(&app);
        loop {
            for _ in 0..60 {
                if STOP.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            tick(&app);
        }
    });
}

/// Beim Beenden: Karte wegraeumen
pub fn shutdown() {
    STOP.store(true, Ordering::Relaxed);
    if SENT.swap(false, Ordering::Relaxed) {
        let _ = request("DELETE", &format!("/activity/{ID}"), "", 400);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, ts: i64) -> Event {
        let title = "Abgabe Aufgabe 1_Mind Map \"Was habe ich im Sport gelernt?\"".to_string();
        Event { id: format!("{kind}{ts}"), ts, all_day: false, kind: kind.into(), short: title.clone(), title, course: Some(1), source: "lernweb".into(), overdue: false, suggested: false, detail: String::new() }
    }

    #[test]
    fn picks_the_next_deadline_or_exam_and_keeps_a_just_missed_one_for_twelve_hours() {
        let now = 1_000_000;
        let list = vec![ev("sitzung", now + 10), ev("frist", now + 5000), ev("pruefung", now + 100), ev("frist", now - 13 * 3600), ev("frist", now - 3600)];
        assert_eq!(pick(&list, now).unwrap().ts, now - 3600);
        assert_eq!(pick(&list[..4], now).unwrap().ts, now + 100);
        assert!(pick(&[ev("sitzung", now + 5)], now).is_none());
        assert!(pick(&[], now).is_none());
    }

    /// Zeitpunkt in Ortszeit (unabhaengig von der Zeitzone des Rechners)
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap().timestamp()
    }

    #[test]
    fn countdown_counts_calendar_days_like_the_ui() {
        let now = at(2026, 10, 14, 13, 40); // Mittwoch
        // Frist So 18.10. 23:55: vier Kalendertage, auch wenn es 4,4 mal 24 Stunden sind
        assert_eq!(countdown(now, at(2026, 10, 18, 23, 55), false), ("4".into(), "Tage"));
        assert_eq!(countdown(now, at(2026, 10, 15, 0, 5), false), ("1".into(), "Tage")); // knapp zehn Stunden, aber morgen
        assert_eq!(countdown(now, at(2026, 10, 14, 23, 59), false), ("11".into(), "Std"));
        assert_eq!(countdown(now, at(2026, 10, 14, 14, 10), false), ("30".into(), "Min"));
        assert_eq!(countdown(now, at(2026, 10, 14, 13, 39), false), ("überfällig".into(), ""));
        assert_eq!(countdown(now, at(2026, 10, 14, 0, 0), true), ("heute".into(), ""));
        assert_eq!(countdown(now, at(2026, 10, 13, 0, 0), true), ("vorbei".into(), ""));
        assert_eq!(countdown(now, at(2026, 12, 1, 12, 0), false), ("48".into(), "Tage"));
    }

    #[test]
    fn card_colors_carry_meaning_and_text_is_short() {
        let now = at(2026, 10, 14, 13, 40);
        let c = card(&ev("frist", at(2026, 10, 17, 12, 0)), now, Some(("Task Design - Group I", 120)));
        assert_eq!(c["color"], colors::hex(120));
        assert_eq!((c["value"].as_str(), c["unit"].as_str()), (Some("3"), Some("Tage")));
        assert_eq!(c["id"], "kursbuch:frist");
        assert!(c["subtitle"].as_str().unwrap().chars().count() <= 22 + 3 + 36);
        assert_eq!(card(&ev("frist", now + 5 * 3600), now, None)["color"], "#ffb340");
        assert_eq!(card(&ev("frist", now - 60), now, None)["color"], "#ff453a");
        assert_eq!(card(&ev("pruefung", now + 86_400 * 9), now, None)["title"], "Nächste Prüfung");
        assert_eq!(c["open"], "kursbuch://heute");
    }

    #[test]
    fn icon_is_a_data_url_in_the_given_color() {
        let i = icon("#ff453a");
        assert!(i.starts_with("data:image/svg+xml;utf8,%3Csvg") && i.contains("%23ff453a") && !i.contains("currentColor"));
    }

    #[test]
    fn short_cuts_long_text_on_a_word_boundary_safe_char_count() {
        assert_eq!(short("abc", 5), "abc");
        assert_eq!(short("Überlänge Übung", 8), "Überlän…");
        assert_eq!(short("äöü", 3), "äöü");
    }
}
