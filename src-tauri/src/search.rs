//! Suche im Volltextindex (data/index.db, gebaut von learnweb-mcp/learnweb/index.py): Namen von Kursen, Abschnitten und
//! Aktivitaeten und der Text aller Dateien (PDF, DOCX, PPTX) mit Seitenzahl. Die App liest nur (SQLite read-only, WAL).
//! Eingaben werden wie im Python-Vorbild (`index.fts_query`) vorbereitet: ß -> ss, jedes Wort in Anfuehrungszeichen mit
//! Praefix-Stern (so sind AND/OR/NEAR/( … nur Text). „Tiefe Suche“ weitet das aus: Wortstaemme, ODER statt UND, Treffer je
//! Dokument zusammengefasst und nach Dichte geordnet (die KI-Neubewertung mit Laya kommt in Phase 5 obendrauf).

use crate::data::{self, Paths};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;
use std::time::Instant;

const OPEN: &str = "\u{1}";
const CLOSE: &str = "\u{2}";
const FILE_KINDS: [&str; 3] = ["pdf", "docx", "pptx"];

/// ß -> ss (der FTS5-Tokenizer faltet ß nicht; der Index ist genauso vorbereitet)
pub fn norm(s: &str) -> String {
    s.replace('ß', "ss").replace('ẞ', "SS")
}

/// Woerter einer Eingabe (Buchstaben und Ziffern), klein, hoechstens 8
pub fn words(q: &str) -> Vec<String> {
    norm(q).to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).take(8).map(String::from).collect()
}

/// Wortstamm fuer die tiefe Suche (deutsche und englische Endungen); kuerzer als vier Zeichen bleibt es, wie es ist
fn stem(w: &str) -> String {
    const SUFFIX: [&str; 19] = ["ierung", "ungen", "keiten", "heiten", "lichen", "ischen", "ung", "keit", "heit", "lich", "isch", "ing", "ed", "en", "er", "es", "em", "e", "s"];
    let n = w.chars().count();
    for s in SUFFIX {
        let k = s.chars().count();
        if w.ends_with(s) && n - k >= 4 {
            return w.chars().take(n - k).collect();
        }
    }
    w.to_string()
}

/// FTS5-Anfrage: schnell = alle Woerter (UND), tief = je Wort mit Stamm, die Woerter durch ODER verbunden
pub fn fts_query(ws: &[String], deep: bool) -> Option<String> {
    if ws.is_empty() {
        return None;
    }
    let quoted = |w: &str| format!("\"{w}\"*");
    if !deep {
        return Some(ws.iter().map(|w| quoted(w)).collect::<Vec<_>>().join(" "));
    }
    let groups: Vec<String> = ws
        .iter()
        .map(|w| {
            let s = stem(w);
            if s == *w { quoted(w) } else { format!("({} OR {})", quoted(w), quoted(&s)) }
        })
        .collect();
    Some(groups.join(" OR "))
}

struct Row {
    course: i64,
    cmid: Option<i64>,
    path: String,
    kind: String,
    title: String,
    page: Option<i64>,
    snippet: String,
}

fn open(db: &Path) -> Result<Connection, String> {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_millis(3000)).map_err(|e| e.to_string())?;
    Ok(c)
}

fn query(db: &Path, expr: &str, courses: &[i64], limit: usize) -> Result<Vec<Row>, String> {
    let con = open(db)?;
    let scope = if courses.is_empty() { String::new() } else { format!(" AND e.course_id IN ({})", vec!["?"; courses.len()].join(",")) };
    let sql = format!(
        "SELECT e.course_id, e.cmid, e.path, e.kind, e.title, e.page, snippet(fts, 1, ?, ?, '…', 16) \
         FROM fts JOIN entries e ON e.id = fts.rowid WHERE fts MATCH ?{scope} ORDER BY bm25(fts, 10.0, 1.0) LIMIT ?"
    );
    let mut params: Vec<Value> = vec![OPEN.to_string().into(), CLOSE.to_string().into(), expr.to_string().into()];
    params.extend(courses.iter().map(|c| Value::from(*c)));
    params.push(Value::from(limit as i64));
    let mut st = con.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params_from_iter(params), |r| {
            Ok(Row { course: r.get(0)?, cmid: r.get(1)?, path: r.get(2)?, kind: r.get(3)?, title: r.get(4)?, page: r.get(5)?, snippet: r.get(6)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Ein Treffer: eine Datei (mit den besten Seiten) oder ein Name (Kurs, Abschnitt, Aktivitaet)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// course | section | activity | pdf | docx | pptx
    pub kind: String,
    pub course: i64,
    pub cmid: Option<i64>,
    pub path: String,
    pub title: String,
    /// Seiten bzw. Folien mit Treffern, beste zuerst (hoechstens 8)
    pub pages: Vec<i64>,
    /// Ausschnitt des besten Treffers; Treffer zwischen \u{1} und \u{2}, kein HTML
    pub snippet: String,
    /// Nummer der Datei in der Aktivitaet (fuer „Oeffnen“), wenn bekannt
    pub file: Option<usize>,
    /// Anzahl der Seiten mit Treffern in dieser Datei
    pub count: usize,
    #[serde(skip)]
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub hits: Vec<Hit>,
    pub ms: u64,
    /// false = es gibt noch keinen Index (noch kein Sync)
    pub indexed: bool,
    /// die Suchwoerter (fuer das Hervorheben in Titeln)
    pub words: Vec<String>,
}

/// Zeilen zu Treffern zusammenfassen: Seiten derselben Datei werden einer, Namen bleiben einzeln.
/// Tief: nach Dichte geordnet (jede Zeile zaehlt mit abnehmendem Gewicht), schnell: Reihenfolge der Rangliste.
fn group(rows: Vec<Row>, deep: bool) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (pos, r) in rows.into_iter().enumerate() {
        let w = 1.0 / (1.0 + pos as f64 * 0.15);
        let is_file = FILE_KINDS.contains(&r.kind.as_str());
        let found = hits.iter_mut().find(|h| h.kind == r.kind && h.course == r.course && h.cmid == r.cmid && if is_file { h.path == r.path } else { h.title == r.title });
        match found {
            Some(h) => {
                h.count += 1;
                h.score += w;
                if let Some(p) = r.page {
                    if h.pages.len() < 8 && !h.pages.contains(&p) {
                        h.pages.push(p);
                    }
                }
            }
            None => hits.push(Hit {
                kind: r.kind,
                course: r.course,
                cmid: r.cmid,
                path: r.path,
                title: r.title,
                pages: r.page.into_iter().collect(),
                snippet: r.snippet,
                file: None,
                count: 1,
                score: w,
            }),
        }
    }
    if deep {
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    }
    hits
}

/// Nummer der Datei in ihrer Aktivitaet (aus dem State), damit ein Klick sie oeffnen kann
fn attach_file_index(paths: &Paths, hits: &mut [Hit]) {
    let Ok(s) = data::state(paths) else { return };
    for h in hits.iter_mut().filter(|h| FILE_KINDS.contains(&h.kind.as_str())) {
        h.file = h
            .cmid
            .and_then(|id| s.courses.get(&h.course.to_string())?.cms.get(&id.to_string()))
            .and_then(|cm| cm.files.iter().position(|f| *f == h.path));
    }
}

pub fn search(paths: &Paths, q: &str, deep: bool, courses: &[i64]) -> Found {
    let t = Instant::now();
    let ws = words(q);
    let db = paths.project.join("data").join("index.db");
    let indexed = db.exists();
    let mut hits = Vec::new();
    if let (true, Some(expr)) = (indexed, fts_query(&ws, deep)) {
        // eine kaputte Anfrage oder ein gerade neu geschriebener Index darf die Oberflaeche nicht stoeren: dann eben keine Treffer
        if let Ok(rows) = query(&db, &expr, courses, if deep { 500 } else { 120 }) {
            hits = group(rows, deep);
            hits.truncate(if deep { 120 } else { 50 });
            attach_file_index(paths, &mut hits);
        }
    }
    Found { hits, ms: t.elapsed().as_millis() as u64, indexed, words: ws }
}

// --------------------------------------------------------------------------- Kontext fuer KI

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseText {
    /// Markdown: Abschnitt -> Aktivitaet -> Datei, je Seite der Text (ß ist im Index zu ss geworden)
    pub text: String,
    pub files: usize,
    /// der Text wurde bei `max_chars` abgeschnitten
    pub truncated: bool,
    /// Dateien dieses Kurses ohne Text im Index (gescannt, kaputt oder noch nicht indexiert)
    pub without_text: usize,
}

/// Text eines Kurses aus dem Index, in der Reihenfolge von LearnWeb, hoechstens `max_chars` Zeichen
pub fn course_text(paths: &Paths, course: i64, max_chars: usize) -> Result<CourseText, String> {
    let s = data::state(paths)?;
    let c = data::course(&s, course)?;
    let db = paths.project.join("data").join("index.db");
    if !db.exists() {
        return Err("Es gibt noch keinen Suchindex (nach dem ersten Sync).".into());
    }
    let con = open(&db)?;
    let mut st = con
        .prepare("SELECT e.page, f.body FROM entries e JOIN fts f ON f.rowid = e.id WHERE e.path = ? AND e.kind IN ('pdf','docx','pptx') ORDER BY e.id")
        .map_err(|e| e.to_string())?;
    let mut out = CourseText { text: String::new(), files: 0, truncated: false, without_text: 0 };
    'all: for (title, ids) in &c.layout {
        let mut heading_done = false;
        for k in ids {
            let Some(cm) = c.cms.get(k) else { continue };
            for f in &cm.files {
                let rows: Vec<(Option<i64>, String)> = st
                    .query_map([f], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect();
                if rows.is_empty() {
                    out.without_text += 1;
                    continue;
                }
                let mut block = String::new();
                if !heading_done {
                    block.push_str(&format!("## {title}\n\n"));
                }
                block.push_str(&format!("### {} – {}\n\n", cm.name, f.rsplit('/').next().unwrap_or(f)));
                for (page, body) in rows {
                    block.push_str(&match page {
                        Some(p) => format!("[S. {p}] {body}\n\n"),
                        None => format!("{body}\n\n"),
                    });
                }
                if out.text.chars().count() + block.chars().count() > max_chars {
                    out.truncated = true;
                    let room = max_chars.saturating_sub(out.text.chars().count());
                    out.text.extend(block.chars().take(room));
                    break 'all;
                }
                heading_done = true;
                out.text.push_str(&block);
                out.files += 1;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Temp-Projekt mit Index (Schema wie index.py) und State; am Ende weg
    struct Proj(PathBuf);
    impl Proj {
        fn new(name: &str) -> Proj {
            let p = std::env::temp_dir().join(format!("kursbuch-search-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(p.join("data")).unwrap();
            let con = Connection::open(p.join("data").join("index.db")).unwrap();
            con.execute_batch(
                "CREATE TABLE entries (id INTEGER PRIMARY KEY, course_id INTEGER, cmid INTEGER, path TEXT, kind TEXT, title TEXT, page INTEGER);
                 CREATE VIRTUAL TABLE fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');",
            )
            .unwrap();
            let add = |course: i64, cmid: Option<i64>, path: &str, kind: &str, title: &str, page: Option<i64>, body: &str| {
                con.execute("INSERT INTO entries(course_id, cmid, path, kind, title, page) VALUES (?,?,?,?,?,?)", rusqlite::params![course, cmid, path, kind, title, page]).unwrap();
                let id = con.last_insert_rowid();
                con.execute("INSERT INTO fts(rowid, title, body) VALUES (?,?,?)", rusqlite::params![id, norm(title), norm(body)]).unwrap();
            };
            add(7, None, "A/A.md", "course", "Sportpsychologie", None, "");
            add(7, Some(1), "A/f.pdf", "pdf", "Folien.pdf", Some(1), "Einleitung zur Gruppendynamik und Kohäsion");
            add(7, Some(1), "A/f.pdf", "pdf", "Folien.pdf", Some(2), "Die Gruppendynamik ändert sich im Verlauf. Große Gruppen sind anders.");
            add(7, Some(1), "A/f.pdf", "pdf", "Folien.pdf", Some(3), "Nur ein Wort: Gruppendynamik");
            add(8, Some(2), "B/g.pptx", "pptx", "Teams.pptx", Some(4), "Teamentwicklung und Gruppen im Sport, Entwicklung der Mannschaft");
            add(7, Some(3), "", "activity", "Gruppendynamik Übung", None, "");
            drop(con);
            let state = serde_json::json!({"last_run": 1, "courses": {
                "7": {"id": 7, "name": "A", "dir": "A", "layout": [["Woche 1", ["1", "3"]]],
                      "cms": {"1": {"name": "Folien", "typ": "resource", "files": ["A/f.pdf", "A/leer.pdf"]}, "3": {"name": "Übung", "typ": "forum"}}},
                "8": {"id": 8, "name": "B", "dir": "B", "layout": [["Woche 1", ["2"]]], "cms": {"2": {"name": "Teams", "typ": "resource", "files": ["B/g.pptx"]}}}}});
            std::fs::write(p.join("data").join("sync_state.json"), state.to_string()).unwrap();
            Proj(p)
        }
        fn paths(&self) -> Paths {
            Paths { project: self.0.clone(), uv: self.0.clone(), config: self.0.clone(), notch: false }
        }
    }
    impl Drop for Proj {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn words_and_queries_are_safe() {
        assert_eq!(words("Größe  und STRAßE!"), ["grösse", "und", "strasse"]); // ö faltet der Tokenizer des Index
        assert_eq!(words("a_b c-d"), ["a", "b", "c", "d"]);
        assert_eq!(words(&"w ".repeat(20)).len(), 8);
        assert_eq!(fts_query(&words("AND OR NEAR ( \" *"), false).unwrap(), "\"and\"* \"or\"* \"near\"*");
        assert_eq!(fts_query(&words("  !? "), false), None);
        assert_eq!(fts_query(&words("Gruppendynamik Sport"), false).unwrap(), "\"gruppendynamik\"* \"sport\"*");
    }

    #[test]
    fn stems_cover_german_and_english_endings() {
        assert_eq!(stem("entwicklungen"), "entwickl");
        assert_eq!(stem("gruppen"), "grupp");
        assert_eq!(stem("running"), "runn");
        assert_eq!(stem("sport"), "sport");
        assert_eq!(stem("teams"), "team");
        assert_eq!(stem("ist"), "ist");
        assert_eq!(fts_query(&words("Entwicklung Sport"), true).unwrap(), "(\"entwicklung\"* OR \"entwickl\"*) OR \"sport\"*");
    }

    #[test]
    fn finds_files_with_pages_names_and_scope() {
        let p = Proj::new("a");
        let paths = p.paths();
        let r = search(&paths, "gruppendynamik", false, &[]);
        assert!(r.indexed && r.hits.len() >= 2);
        let file = r.hits.iter().find(|h| h.kind == "pdf").unwrap();
        assert_eq!((file.count, file.pages.len(), file.file, file.cmid), (3, 3, Some(0), Some(1)));
        assert!(file.snippet.contains('\u{1}') && file.snippet.contains('\u{2}'));
        assert!(r.hits.iter().any(|h| h.kind == "activity" && h.title == "Gruppendynamik Übung"));
        // alle Woerter muessen vorkommen (UND)
        assert_eq!(search(&paths, "gruppendynamik kohasion", false, &[]).hits.iter().filter(|h| h.kind == "pdf").count(), 1);
        // Semester/Kurs-Filter
        assert!(search(&paths, "gruppen", false, &[8]).hits.iter().all(|h| h.course == 8));
        assert!(search(&paths, "gruppendynamik", false, &[8]).hits.is_empty());
    }

    #[test]
    fn umlauts_and_sharp_s_match_both_ways() {
        let p = Proj::new("b");
        let paths = p.paths();
        assert!(!search(&paths, "kohäsion", false, &[]).hits.is_empty());
        assert!(!search(&paths, "kohasion", false, &[]).hits.is_empty());
        assert!(!search(&paths, "große", false, &[]).hits.is_empty()); // im Index: „Grosse“
        assert!(!search(&paths, "grosse", false, &[]).hits.is_empty());
    }

    #[test]
    fn deep_search_widens_and_orders_by_density() {
        let p = Proj::new("c");
        let paths = p.paths();
        assert!(search(&paths, "entwicklungen", false, &[]).hits.is_empty()); // Wortform kommt so nicht vor
        let r = search(&paths, "entwicklungen", true, &[]);
        assert!(r.hits.iter().any(|h| h.path == "B/g.pptx")); // „Entwicklung“ und „Teamentwicklung“ ueber den Stamm
        let d = search(&paths, "gruppendynamik sport", true, &[]);
        assert!(d.hits.len() >= 3);
        assert!(d.hits.windows(2).all(|w| w[0].score >= w[1].score));
        assert_eq!(d.hits[0].kind, "pdf"); // drei Seiten mit „Gruppendynamik“ vor einem Einzeltreffer
    }

    #[test]
    fn hostile_input_and_missing_index_give_no_hits_and_no_error() {
        let p = Proj::new("d");
        let paths = p.paths();
        for q in ["", "   ", "AND OR NEAR ( \" *", "'; DROP TABLE entries; --", "a:b -c ^d", "\u{0}"] {
            let r = search(&paths, q, false, &[]);
            assert!(r.indexed);
            let _ = search(&paths, q, true, &[]);
        }
        let none = Paths { project: p.0.join("nix"), uv: p.0.clone(), config: p.0.clone(), notch: false };
        assert!(!search(&none, "x", false, &[]).indexed);
    }

    /// Eigenschaft: egal, was getippt wird, die Anfrage an FTS5 ist gueltig (kein Syntaxfehler, kein Absturz), schnell wie tief.
    /// Zufallseingaben aus Operatoren, Anfuehrungszeichen, Klammern, Steuerzeichen und Zeichen aus vielen Schriften.
    #[test]
    fn any_input_makes_a_valid_fts_query() {
        let p = Proj::new("f");
        let db = p.0.join("data").join("index.db");
        let alphabet: Vec<&str> = vec![
            "\"", "'", "*", "(", ")", ":", "-", "^", "+", "~", "{", "}", "[", "]", ",", ".", ";", "/", "\\", "%", "_", " ", "\t", "\n", "\u{0}", "\u{1}", "\u{2}",
            "AND", "OR", "NOT", "NEAR", "near/2", "a", "z", "Z", "0", "9", "ß", "ẞ", "ä", "É", "ñ", "ø", "ł", "İ", "ǅ", "²", "½", "ª", "٣", "中", "文", "日", "한", "я", "α",
            "\u{301}", "\u{200d}", "😀", "👨‍👩‍👧", "\u{fffd}", "\u{10ffff}", "e\u{301}",
        ];
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..1500 {
            let len = (next() % 14) as usize;
            let q: String = (0..len).map(|_| alphabet[(next() % alphabet.len() as u64) as usize]).collect();
            for deep in [false, true] {
                if let Some(expr) = fts_query(&words(&q), deep) {
                    assert!(query(&db, &expr, &[], 10).is_ok(), "{q:?} (deep={deep}) -> {expr}");
                }
            }
        }
    }

    #[test]
    fn course_text_follows_the_layout_and_respects_the_limit() {
        let p = Proj::new("e");
        let paths = p.paths();
        let t = course_text(&paths, 7, 10_000).unwrap();
        assert_eq!((t.files, t.truncated, t.without_text), (1, false, 1)); // leer.pdf hat keinen Text im Index
        assert!(t.text.starts_with("## Woche 1\n\n### Folien – f.pdf\n\n[S. 1] Einleitung"));
        assert!(t.text.contains("[S. 3] Nur ein Wort"));
        let short = course_text(&paths, 7, 120).unwrap();
        assert!(short.truncated && short.text.chars().count() <= 120);
        assert!(course_text(&paths, 99, 100).is_err());
    }
}
