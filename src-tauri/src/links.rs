//! Deep Link `kursbuch://` (aus der Notch, aus dem Startmenue-Dialog, von jedem Programm und jeder Webseite).
//! Ein Link darf nur NAVIGIEREN: heute, einen Kurs (ID, die der State kennen muss) oder einen Suchbegriff eintragen.
//! Nie ein Pfad, nie etwas ausfuehren, nie etwas aendern. Alles Unbekannte oder Verformte wird ignoriert.

use percent_encoding::percent_decode_str;
use serde::Serialize;

#[derive(Debug, PartialEq, Clone, Serialize)]
#[serde(tag = "view", content = "arg", rename_all = "lowercase")]
pub enum Link {
    Heute,
    /// Fokus-Ansicht (Notch-Karte des Pomodoro: holt die App nach vorn)
    Fokus,
    Kurs(i64),
    Suche(String),
}

pub fn parse(url: &str) -> Option<Link> {
    let (scheme, rest) = url.split_at_checked("kursbuch://".len())?;
    if !scheme.eq_ignore_ascii_case("kursbuch://") || rest.len() > 400 {
        return None;
    }
    let rest = rest.trim_end_matches('/'); // Browser und Windows haengen gern einen Schraegstrich an
    let (head, arg) = match rest.split_once('/') {
        Some((h, a)) => (h, Some(a)),
        None => (rest, None),
    };
    match (head.to_ascii_lowercase().as_str(), arg) {
        ("heute", None) => Some(Link::Heute),
        ("fokus", None) => Some(Link::Fokus),
        ("kurs", Some(id)) if (1..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) => id.parse().ok().map(Link::Kurs),
        ("suche", Some(q)) => {
            let q = percent_decode_str(q).decode_utf8().ok()?;
            let q = q.trim();
            (!q.is_empty() && q.chars().count() <= 100 && !q.chars().any(char::is_control)).then(|| Link::Suche(q.to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_links() {
        assert_eq!(parse("kursbuch://heute"), Some(Link::Heute));
        assert_eq!(parse("kursbuch://heute/"), Some(Link::Heute));
        assert_eq!(parse("kursbuch://fokus"), Some(Link::Fokus));
        assert_eq!(parse("KURSBUCH://Heute"), Some(Link::Heute));
        assert_eq!(parse("kursbuch://kurs/96952"), Some(Link::Kurs(96952)));
        assert_eq!(parse("kursbuch://kurs/96952/"), Some(Link::Kurs(96952)));
        assert_eq!(parse("kursbuch://suche/Selbstwirksamkeit"), Some(Link::Suche("Selbstwirksamkeit".into())));
        assert_eq!(parse("kursbuch://suche/Gr%C3%B6%C3%9Fe%20und%20Stra%C3%9Fe"), Some(Link::Suche("Größe und Straße".into())));
        assert_eq!(parse("kursbuch://suche/%20%20x%20"), Some(Link::Suche("x".into())));
    }

    #[test]
    fn deformed_or_hostile_links_are_ignored() {
        for url in [
            "", "kursbuch:", "kursbuch://", "kursbuch:/heute", "https://heute", "kursbuch://unbekannt", "kursbuch://heute/x",
            "kursbuch://heute?x=1", "kursbuch://heute#a", "kursbuch://kurs", "kursbuch://kurs/", "kursbuch://kurs/abc", "kursbuch://kurs/-1",
            "kursbuch://kurs/+5", "kursbuch://kurs/1.5", "kursbuch://kurs/12/13", "kursbuch://kurs/1234567890123", "kursbuch://kurs/%31%32",
            "kursbuch://kurs/..%2f..%2fWindows", "kursbuch://kurs/..\\..", "kursbuch://kurs/99999999999999999999",
            "kursbuch://suche", "kursbuch://suche/", "kursbuch://suche/%20%20", "kursbuch://suche/%00", "kursbuch://suche/a%0Ab",
            "kursbuch://suche/%FF%FE", "kursbuch://datei/C:/Windows/notepad.exe", "kursbuch://öffne", "javascript:alert(1)",
        ] {
            assert_eq!(parse(url), None, "{url:?} muss ignoriert werden");
        }
        assert_eq!(parse(&format!("kursbuch://suche/{}", "a".repeat(101))), None);
        assert_eq!(parse(&format!("kursbuch://suche/{}", "a".repeat(500))), None);
        assert_eq!(parse(&format!("kursbuch://suche/{}", "ä".repeat(100))), Some(Link::Suche("ä".repeat(100)))); // Grenze zählt Zeichen
    }
}
