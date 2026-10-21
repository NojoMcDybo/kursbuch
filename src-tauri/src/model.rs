//! Datenvertrag mit der Python-Seite (`bridge/`, die mitgelieferte Brücke, bzw. `~\learnweb-mcp` im Entwickler-Betrieb): data/sync_state.json und
//! sync_config.json. Gelesen wird nur, was die App braucht; Unbekanntes bleibt unbeachtet, damit neue Felder auf der
//! Python-Seite die App nicht stoeren.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Default)]
pub struct State {
    pub last_run: Option<i64>,
    #[serde(default)]
    pub courses: HashMap<String, CourseRec>,
}

#[derive(Deserialize, Clone)]
pub struct CourseRec {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Ordnername relativ zu `ziel`
    pub dir: String,
    /// Reihenfolge wie in LearnWeb: (Abschnittstitel, cmids)
    #[serde(default)]
    pub layout: Vec<(String, Vec<String>)>,
    #[serde(default)]
    pub cms: HashMap<String, Cm>,
}

#[derive(Deserialize, Clone, Default)]
pub struct Cm {
    pub name: String,
    pub typ: String,
    #[serde(default)]
    pub url: Option<String>,
    /// relativ zu `ziel`, mit `/`
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub skipped: Vec<Skipped>,
    #[serde(default)]
    pub error: Option<String>,
    /// Unix-Zeit des ersten Auftauchens bzw. der letzten Dateiaktualisierung; fehlt in alten Daten = alt.
    /// „Neu seit letztem Oeffnen“ (Phase 3) liest sie.
    #[serde(default)]
    #[allow(dead_code)]
    pub seen_at: Option<i64>,
    #[serde(default)]
    #[allow(dead_code)]
    pub updated_at: Option<i64>,
}

#[derive(Deserialize, Clone)]
pub struct Skipped {
    pub mb: f64,
}

#[derive(Deserialize)]
pub struct Config {
    pub ziel: String,
}

/// Kursname aus LearnWeb in Titel, Semester und Dozent zerlegt:
/// "Gulliver's Travels at 300 WiSe 2026/27, Kirsten Juhas" -> ("Gulliver's Travels at 300", "WiSe 2026/27", "Kirsten Juhas")
#[derive(Debug, PartialEq)]
pub struct Name {
    pub title: String,
    pub semester: Option<String>,
    pub teacher: Option<String>,
}

/// Byte-Bereich des ersten Semesters ("WiSe 2026/27", "SoSe 2026", "WiSe 2026-2027")
fn find_semester(s: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for key in ["WiSe ", "SoSe "] {
        let mut from = 0;
        while let Some(p) = s[from..].find(key) {
            let start = from + p;
            let boundary = s[..start].chars().next_back().map_or(true, |c| !c.is_alphanumeric());
            let digits = s[start + key.len()..].chars().take_while(|c| c.is_ascii_digit()).count();
            if boundary && digits == 4 {
                let mut end = start + key.len() + 4;
                let tail = &s[end..];
                if tail.starts_with('/') || tail.starts_with('-') {
                    let more = tail[1..].chars().take_while(|c| c.is_ascii_digit()).count();
                    if more == 2 || more == 4 {
                        end += 1 + more;
                    }
                }
                if best.map_or(true, |(b, _)| start < b) {
                    best = Some((start, end));
                }
                break;
            }
            from = start + key.len();
        }
    }
    best
}

/// Einheitliche Schreibweise, damit „WiSe 2026/27“, „WiSe 2026-2027“ und „WiSe 2026“ eine Gruppe bilden
fn canonical(sem: &str) -> String {
    let year: u32 = sem.get(5..9).and_then(|y| y.parse().ok()).unwrap_or(0);
    if sem.starts_with("WiSe") {
        format!("WiSe {year}/{:02}", (year + 1) % 100)
    } else {
        format!("SoSe {year}")
    }
}

pub fn split_name(full: &str) -> Name {
    let full = full.trim();
    let Some((a, b)) = find_semester(full) else {
        return Name { title: full.to_string(), semester: None, teacher: None };
    };
    let before = full[..a].trim_end();
    let after = full[b..].trim();
    let (rest, teacher) = match after.strip_prefix(',') {
        Some(t) => ("", Some(t.trim().to_string()).filter(|t| !t.is_empty())),
        None => (after, None),
    };
    let title = [before, rest].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" ");
    Name { title: if title.is_empty() { full.to_string() } else { title }, semester: Some(canonical(&full[a..b])), teacher }
}

/// Art der Veranstaltung aus dem Titel: vorlesung | seminar | uebung (sonst keine Angabe)
pub fn course_kind(title: &str) -> Option<&'static str> {
    let t = title.to_lowercase();
    let word = |w: &str| t.split(|c: char| !c.is_alphanumeric()).any(|x| x == w);
    if word("vl") || t.contains("vorlesung") || t.contains("lecture") {
        Some("vorlesung")
    } else if t.contains("seminar") || t.contains("kolloquium") || t.contains("colloquium") || t.contains("workshop") {
        Some("seminar")
    } else if t.contains("übung") || t.contains("uebung") || t.contains("tutorium") || t.contains("tutorial") || t.contains("exercise") {
        Some("uebung")
    } else {
        None
    }
}

/// Sortierwert: neueres Semester zuerst (WiSe 2026/27 vor SoSe 2026), ohne Semester = 0
pub fn semester_rank(sem: Option<&str>) -> i32 {
    let Some(s) = sem else { return 0 };
    let year: i32 = s.get(5..9).and_then(|y| y.parse().ok()).unwrap_or(0);
    year * 2 + i32::from(s.starts_with("WiSe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(full: &str) -> (String, Option<String>, Option<String>) {
        let x = split_name(full);
        (x.title, x.semester, x.teacher)
    }

    #[test]
    fn names_from_real_courses() {
        assert_eq!(
            n("Gulliver's Travels at 300 WiSe 2026/27, Kirsten Juhas"),
            ("Gulliver's Travels at 300".into(), Some("WiSe 2026/27".into()), Some("Kirsten Juhas".into()))
        );
        // „WiSe 2026-2027“ und „WiSe 2026“ meinen dasselbe Semester wie „WiSe 2026/27“ und werden so geschrieben
        assert_eq!(
            n("Unterrichten im Sport - Begleitseminare WiSe 2026-2027"),
            ("Unterrichten im Sport - Begleitseminare".into(), Some("WiSe 2026/27".into()), None)
        );
        assert_eq!(
            n("Tennis Plus SoSe 2026, Axel Binnenbruck, Brunert Willi"),
            ("Tennis Plus".into(), Some("SoSe 2026".into()), Some("Axel Binnenbruck, Brunert Willi".into()))
        );
        assert_eq!(
            n("Introduction to English Linguistics II (Group III) SoSe 2026, Muhammad Shakir"),
            ("Introduction to English Linguistics II (Group III)".into(), Some("SoSe 2026".into()), Some("Muhammad Shakir".into()))
        );
        assert_eq!(n("GK2 Intro to Literary + Cultural Studies"), ("GK2 Intro to Literary + Cultural Studies".into(), None, None));
    }

    #[test]
    fn semester_inside_the_name_stays_part_of_the_title() {
        // Zweites "WiSe 24/25" ist kein Semester im Sinn der Zerlegung; der Rest nach dem ersten bleibt im Titel
        assert_eq!(
            n("Wahlverfahren WiSe 2026 Sportwissenschaft - Kohorte Studienstart WiSe 24/25 (5. FS)"),
            ("Wahlverfahren Sportwissenschaft - Kohorte Studienstart WiSe 24/25 (5. FS)".into(), Some("WiSe 2026/27".into()), None)
        );
        assert_eq!(n("MySoSe 2026 Kurs").1, None); // kein Wortanfang
        assert_eq!(n("SoSe 2026").0, "SoSe 2026"); // nur ein Semester: nicht zu leerem Titel machen
        assert_eq!(n("Kurs WiSe 2099 x").1.as_deref(), Some("WiSe 2099/00")); // Jahrhundertwechsel ohne Absturz
    }

    #[test]
    fn course_kind_from_real_titles() {
        for (t, k) in [("VL Sportpsychologie", Some("vorlesung")), ("VL Unterrichten im Sport", Some("vorlesung")), ("Lecture: Intro", Some("vorlesung")), ("Unterrichten im Sport - Begleitseminare", Some("seminar")),
            ("Hauptseminar Taktik", Some("seminar")), ("Statistik Übung", Some("uebung")), ("Tutorium Mathe", Some("uebung")), ("Introduction to English Linguistics II (Group III)", None),
            ("Task Design - Group I", None), ("Tennis Plus", None), ("Wahlverfahren Sportwissenschaft", None), ("Evolution", None), ("", None)] {
            assert_eq!(course_kind(t), k, "{t}");
        }
    }

    #[test]
    fn newer_semester_sorts_first() {
        let r = |s| semester_rank(Some(s));
        assert!(r("WiSe 2026/27") > r("SoSe 2026"));
        assert!(r("SoSe 2026") > r("WiSe 2025/26"));
        assert!(r("SoSe 2026") > semester_rank(None));
    }

    #[test]
    fn state_tolerates_old_and_new_fields() {
        let s: State = serde_json::from_str(
            r#"{"last_run": 5, "digest": [], "courses": {"7": {"id": 7, "name": "A", "url": null, "dir": "A",
                "layout": [["Woche 1", ["1", "2"]]],
                "cms": {"1": {"name": "F", "typ": "resource", "url": "u", "files": ["A/f.pdf"], "skipped": [{"mb": 34.2}], "seen_at": 9},
                        "2": {"name": "L", "typ": "label", "section": "x"}}}}}"#,
        )
        .unwrap();
        let c = &s.courses["7"];
        assert_eq!(c.layout[0].1, ["1", "2"]);
        assert_eq!((c.cms["1"].seen_at, c.cms["1"].updated_at, c.cms["1"].skipped[0].mb), (Some(9), None, 34.2));
        assert!(c.cms["2"].files.is_empty() && c.cms["2"].error.is_none());
    }
}
