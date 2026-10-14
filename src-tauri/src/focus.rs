//! Fokus: To-do-Listen, Pomodoro-Einstellungen und Lernstreaks (focus.json im App-Ordner, nichts davon verlaesst den Rechner).
//! Eine „Sitzung“ ist eine abgeschlossene Fokusphase; ein Tag zaehlt fuer den Streak, wenn er mindestens eine hat. Der Streak
//! laeuft weiter, solange heute oder gestern eine Sitzung liegt (heute darf noch kommen).

use crate::data::Paths;
use crate::store;
use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use tauri::State;

const MAX_LISTS: usize = 30;
const MAX_ITEMS: usize = 300;
const MAX_SESSIONS: usize = 10_000;
const KEEP_DAYS: i64 = 400;
const HEAT_DAYS: i64 = 84;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Todo {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TodoList {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub items: Vec<Todo>,
}

/// Laengen in Minuten: Fokus und kurze Pause (die lange Pause nach vier Runden ist das Dreifache der kurzen)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub focus: u32,
    pub pause: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { focus: 25, pause: 5 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    /// Ende der Fokusphase (Unix-Sekunden)
    pub ts: i64,
    pub minutes: u32,
    #[serde(default)]
    pub task: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Data {
    #[serde(default)]
    lists: Vec<TodoList>,
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    sessions: Vec<Session>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Stats {
    /// aufeinanderfolgende Tage mit Sitzung bis heute (bzw. gestern)
    pub current: u32,
    pub best: u32,
    pub today: u32,
    pub today_minutes: u32,
    pub total: u32,
    /// Sitzungen je Tag der letzten 12 Wochen: (Tag seit 1970 im lokalen Kalender, Anzahl)
    pub days: Vec<(i64, u32)>,
    /// heutiger Tag im selben Zaehlmass (die Oberflaeche rechnet damit das Raster)
    pub today_day: i64,
}

fn day_of(ts: i64) -> i64 {
    let d = Local.timestamp_opt(ts, 0).single().map(|t| t.date_naive()).unwrap_or_default();
    (d - NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days()
}

pub fn stats(sessions: &[Session], now: i64) -> Stats {
    let today = day_of(now);
    let mut per_day: BTreeMap<i64, u32> = BTreeMap::new();
    for s in sessions {
        *per_day.entry(day_of(s.ts)).or_default() += 1;
    }
    let days: BTreeSet<i64> = per_day.keys().copied().collect();
    // beste Reihe aufeinanderfolgender Tage
    let (mut best, mut run, mut prev) = (0u32, 0u32, i64::MIN);
    for &d in &days {
        run = if d == prev + 1 { run + 1 } else { 1 };
        best = best.max(run);
        prev = d;
    }
    // aktuelle Reihe: ab heute, sonst ab gestern rueckwaerts
    let mut cur = 0u32;
    let mut d = if days.contains(&today) { today } else { today - 1 };
    while days.contains(&d) {
        cur += 1;
        d -= 1;
    }
    Stats {
        current: cur,
        best,
        today: per_day.get(&today).copied().unwrap_or(0),
        today_minutes: sessions.iter().filter(|s| day_of(s.ts) == today).map(|s| s.minutes).sum(),
        total: sessions.len() as u32,
        days: per_day.range(today - HEAT_DAYS + 1..=today).map(|(d, n)| (*d, *n)).collect(),
        today_day: today,
    }
}

pub fn validate(lists: &[TodoList], settings: &Settings) -> Result<(), String> {
    if lists.len() > MAX_LISTS {
        return Err(format!("Zu viele Listen (höchstens {MAX_LISTS})."));
    }
    let mut ids = std::collections::HashSet::new();
    for l in lists {
        if l.id.is_empty() || l.id.chars().count() > 64 || !ids.insert(&l.id) || l.name.trim().is_empty() || l.name.chars().count() > 60 || l.items.len() > MAX_ITEMS {
            return Err("Liste ungültig (Name höchstens 60 Zeichen, höchstens 300 Aufgaben).".into());
        }
        let mut item_ids = std::collections::HashSet::new();
        for t in &l.items {
            if t.id.is_empty() || t.id.chars().count() > 64 || !item_ids.insert(&t.id) || t.text.trim().is_empty() || t.text.chars().count() > 200 {
                return Err("Aufgabe ungültig (Text höchstens 200 Zeichen).".into());
            }
        }
    }
    if !(1..=180).contains(&settings.focus) || !(1..=60).contains(&settings.pause) {
        return Err("Fokus 1–180 Minuten, Pause 1–60 Minuten.".into());
    }
    Ok(())
}

fn file(paths: &Paths) -> PathBuf {
    paths.config.join("focus.json")
}

fn load(paths: &Paths) -> Result<Data, String> {
    store::read(&file(paths)).map(Option::unwrap_or_default).map_err(|e| format!("Die Fokus-Daten sind nicht lesbar: {e}"))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Serialize)]
pub struct Focus {
    pub lists: Vec<TodoList>,
    pub settings: Settings,
    pub stats: Stats,
}

pub fn get(paths: &Paths) -> Result<Focus, String> {
    let d = load(paths)?;
    let stats = stats(&d.sessions, now());
    Ok(Focus { lists: d.lists, settings: d.settings, stats })
}

/// Listen und Einstellungen speichern; die Sitzungen bleiben unberuehrt (die Oberflaeche schreibt sie nie selbst)
pub fn save(paths: &Paths, lists: Vec<TodoList>, settings: Settings) -> Result<(), String> {
    validate(&lists, &settings)?;
    let mut d: Data = store::read_or_quarantine(&file(paths)).unwrap_or_default();
    d.lists = lists;
    d.settings = settings;
    store::write(&file(paths), &d)
}

/// Eine abgeschlossene Fokusphase festhalten; Rueckgabe: neue Zahlen
pub fn log(paths: &Paths, minutes: u32, task: &str, at: i64) -> Result<Stats, String> {
    if !(1..=180).contains(&minutes) {
        return Err("Minuten ungültig.".into());
    }
    let mut d: Data = store::read_or_quarantine(&file(paths)).unwrap_or_default();
    d.sessions.push(Session { ts: at, minutes, task: task.chars().take(200).collect() });
    let keep_from = day_of(at) - KEEP_DAYS;
    d.sessions.retain(|s| day_of(s.ts) >= keep_from);
    if d.sessions.len() > MAX_SESSIONS {
        let cut = d.sessions.len() - MAX_SESSIONS;
        d.sessions.drain(..cut);
    }
    store::write(&file(paths), &d)?;
    Ok(stats(&d.sessions, at))
}

#[tauri::command]
pub fn focus_get(paths: State<Paths>) -> Result<Focus, String> {
    get(&paths)
}

#[tauri::command]
pub fn focus_save(paths: State<Paths>, lists: Vec<TodoList>, settings: Settings) -> Result<(), String> {
    save(&paths, lists, settings)
}

#[tauri::command]
pub fn focus_log(paths: State<Paths>, minutes: u32, task: String) -> Result<Stats, String> {
    log(&paths, minutes, &task, now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, h: u32) -> i64 {
        Local.with_ymd_and_hms(y, m, d, h, 30, 0).single().unwrap().timestamp()
    }

    fn s(ts: i64) -> Session {
        Session { ts, minutes: 25, task: String::new() }
    }

    fn list(id: &str, name: &str, items: &[&str]) -> TodoList {
        TodoList { id: id.into(), name: name.into(), items: items.iter().enumerate().map(|(i, t)| Todo { id: format!("{id}-{i}"), text: (*t).into(), done: false }).collect() }
    }

    #[test]
    fn streak_runs_through_today_or_yesterday_and_breaks_on_a_gap() {
        let now = at(2026, 10, 14, 15);
        let st = stats(&[s(at(2026, 10, 12, 9)), s(at(2026, 10, 13, 9)), s(at(2026, 10, 14, 8)), s(at(2026, 10, 14, 10))], now);
        assert_eq!((st.current, st.best, st.today, st.today_minutes, st.total), (3, 3, 2, 50, 4));
        // heute noch nichts, gestern ja: die Reihe lebt noch
        let st = stats(&[s(at(2026, 10, 12, 9)), s(at(2026, 10, 13, 9))], now);
        assert_eq!((st.current, st.today), (2, 0));
        // vorgestern war die letzte: Reihe vorbei, beste bleibt
        let st = stats(&[s(at(2026, 10, 10, 9)), s(at(2026, 10, 11, 9)), s(at(2026, 10, 12, 9))], now);
        assert_eq!((st.current, st.best), (0, 3));
        assert_eq!(stats(&[], now), Stats { today_day: day_of(now), ..Default::default() });
    }

    /// Eigenschaft: gegen eine einfache Zaehlung ueber Tage verglichen (zufaellige Tagesmengen)
    #[test]
    fn streak_matches_a_naive_count_for_random_day_sets() {
        let mut x: u64 = 0x1234_5678_9abc_def1;
        let mut next = move || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
        let now = at(2026, 10, 14, 15);
        let today = day_of(now);
        for _ in 0..400 {
            let days: BTreeSet<i64> = (0..(next() % 40)).map(|_| today - (next() % 30) as i64 + (next() % 2) as i64).filter(|d| *d <= today).collect();
            let sessions: Vec<Session> = days.iter().map(|d| s(now - (today - d) * 86_400 - 3600 * ((next() % 3) as i64))).collect();
            // die Zeitstempel koennen bei Sommerzeitwechsel um eine Stunde verrutschen: Tage aus den Zeitstempeln selbst nehmen
            let real: BTreeSet<i64> = sessions.iter().map(|x| day_of(x.ts)).collect();
            let mut cur = 0;
            let mut d = if real.contains(&today) { today } else { today - 1 };
            while real.contains(&d) { cur += 1; d -= 1; }
            let mut best = 0;
            for &start in &real {
                if real.contains(&(start - 1)) { continue; }
                let mut n = 0;
                while real.contains(&(start + n)) { n += 1; }
                best = best.max(n as u32);
            }
            let st = stats(&sessions, now);
            assert_eq!((st.current, st.best, st.total), (cur, best, sessions.len() as u32));
        }
    }

    #[test]
    fn validation_rejects_broken_lists_and_settings() {
        let ok = Settings::default();
        assert!(validate(&[list("a", "Heute", &["x", "y"])], &ok).is_ok());
        assert!(validate(&[list("a", " ", &[])], &ok).is_err());
        assert!(validate(&[list("a", "A", &[]), list("a", "B", &[])], &ok).is_err());
        assert!(validate(&[list("a", &"x".repeat(61), &[])], &ok).is_err());
        assert!(validate(&[list("a", "A", &[&"y".repeat(201)])], &ok).is_err());
        assert!(validate(&[list("a", "A", &[" "])], &ok).is_err());
        assert!(validate(&(0..31).map(|i| list(&format!("{i}"), "L", &[])).collect::<Vec<_>>(), &ok).is_err());
        for bad in [Settings { focus: 0, pause: 5 }, Settings { focus: 181, pause: 5 }, Settings { focus: 25, pause: 0 }, Settings { focus: 25, pause: 61 }] {
            assert!(validate(&[], &bad).is_err());
        }
    }

    #[test]
    fn save_keeps_sessions_and_log_prunes_old_ones() {
        let dir = std::env::temp_dir().join(format!("kursbuch-focus-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = Paths { project: dir.clone(), uv: dir.clone(), config: dir.join("cfg"), notch: false };
        let now = at(2026, 10, 14, 15);
        assert!(get(&p).unwrap().lists.is_empty());
        let st = log(&p, 25, "Kapitel 3", now).unwrap();
        assert_eq!((st.current, st.today, st.total), (1, 1, 1));
        save(&p, vec![list("a", "Heute", &["Folien lesen"])], Settings { focus: 50, pause: 10 }).unwrap();
        let g = get(&p).unwrap();
        assert_eq!((g.lists[0].items[0].text.as_str(), g.settings.focus), ("Folien lesen", 50));
        assert_eq!(g.stats.total, 1); // gespeicherte Listen lassen die Sitzungen stehen
        assert!(save(&p, vec![], Settings { focus: 0, pause: 5 }).is_err());
        assert!(log(&p, 0, "", now).is_err());
        // alte Sitzungen (ueber 400 Tage) fliegen beim naechsten Eintrag raus
        log(&p, 25, "", now - 500 * 86_400).unwrap();
        assert_eq!(log(&p, 25, "", now).unwrap().total, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
