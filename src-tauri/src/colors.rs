//! Kursfarben: Jeder Kurs bekommt beim ersten Auftauchen einen Farbton (0-359) und behaelt ihn, auch wenn Kurse
//! dazukommen oder wegfallen (`colors.json` im App-Ordner). Neue Toene liegen moeglichst weit von den vergebenen.

use crate::data::Paths;
use std::collections::HashMap;
use std::sync::Mutex;

static HUES: Mutex<Option<HashMap<i64, u16>>> = Mutex::new(None);

fn dist(a: u16, b: u16) -> u16 {
    let d = a.abs_diff(b);
    d.min(360 - d)
}

/// Der Ton mit dem groessten Abstand zum naechsten vergebenen (Raster 3 Grad); der erste Kurs bekommt Violett wie das App-Symbol
fn farthest(used: &[u16]) -> u16 {
    if used.is_empty() {
        return 283;
    }
    (0u16..360).step_by(3).max_by_key(|h| used.iter().map(|u| dist(*h, *u)).min().unwrap_or(180)).unwrap_or(283)
}

fn load(paths: &Paths) -> HashMap<i64, u16> {
    std::fs::read(paths.config.join("colors.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, u16>>(&b).ok())
        .map(|m| m.into_iter().filter_map(|(k, v)| Some((k.parse().ok()?, v % 360))).collect())
        .unwrap_or_default()
}

fn save(paths: &Paths, map: &HashMap<i64, u16>) {
    let m: HashMap<String, u16> = map.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let _ = std::fs::create_dir_all(&paths.config);
    let _ = std::fs::write(paths.config.join("colors.json"), serde_json::to_vec(&m).unwrap_or_default());
}

/// Farbtoene aller genannten Kurse; fehlende werden vergeben (in der Reihenfolge der IDs, damit es reproduzierbar bleibt)
pub fn hues(paths: &Paths, ids: &[i64]) -> HashMap<i64, u16> {
    let mut guard = HUES.lock().unwrap();
    let map = guard.get_or_insert_with(|| load(paths));
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    let mut changed = false;
    for id in ids {
        if !map.contains_key(&id) {
            let used: Vec<u16> = map.values().copied().collect();
            map.insert(id, farthest(&used));
            changed = true;
        }
    }
    if changed {
        save(paths, map);
    }
    map.clone()
}

/// Farbton als Hex (wie in der Oberflaeche: hsl(Ton 68% 62%)), z. B. fuer die Notch-Karte
pub fn hex(hue: u16) -> String {
    let (h, s, l) = (hue as f64 % 360.0, 0.68_f64, 0.62_f64);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let byte = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seventeen_courses_get_well_separated_hues() {
        let mut used: Vec<u16> = vec![];
        for _ in 0..17 {
            used.push(farthest(&used));
        }
        let min = (0..used.len()).flat_map(|i| (0..i).map(move |j| (i, j))).map(|(i, j)| dist(used[i], used[j])).min().unwrap();
        assert!(min >= 12, "kleinster Abstand {min} Grad: {used:?}");
        assert_eq!(used[0], 283);
    }

    #[test]
    fn hex_matches_known_colors() {
        // hsl(0 68% 62%): c = 0,76 * 0,68 = 0,5168, m = 0,3616 -> rot 224 (e0), gruen/blau 92 (5c)
        assert_eq!(hex(0), "#e05c5c");
        assert_eq!(hex(120), "#5ce05c");
        assert_eq!(hex(240), "#5c5ce0");
        assert_eq!(hex(360), hex(0));
        assert!(hex(283).starts_with('#'));
    }

    #[test]
    fn distance_wraps_around() {
        assert_eq!(dist(350, 10), 20);
        assert_eq!(dist(0, 180), 180);
    }
}
