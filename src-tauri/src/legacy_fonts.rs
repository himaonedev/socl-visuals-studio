//! Bundled-font geometry for the legacy caption editor, served by Rust.
//! The metadata is measured from the font files at build time; no JS runtime
//! or guessed system-font metrics are needed in the installed application.
use serde_json::{Value, json};
use std::sync::OnceLock;

fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../assets/socl-font-metrics.json"))
            .expect("bundled font metadata")
    })
}

fn normalized(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn face(name: &str, bold: bool) -> Option<&'static Value> {
    let direct = normalized(name);
    let loose = normalized(&name.replace(['-', '_'], " "));
    let state = if bold { "|b|" } else { "||" };
    for key in [
        format!("{direct}{state}"),
        format!("{loose}{state}"),
        direct,
        loose,
    ] {
        if let Some(entry) = data()["faces"].get(&key) {
            return Some(entry);
        }
    }
    None
}

pub fn metrics(request: &Value) -> Value {
    let mut results = serde_json::Map::new();
    for item in request.as_array().into_iter().flatten() {
        let style = item["style"].as_str().unwrap_or("");
        let requested = item["fn"].as_str().unwrap_or("");
        let key = format!("{style}|{requested}");
        if results.contains_key(&key) {
            continue;
        }
        let spec = &data()["styles"][style];
        let name = if requested.is_empty() {
            spec["font"].as_str().unwrap_or("Open Sauce Two ExtraBold")
        } else {
            requested
        };
        let bold = spec["bold"].as_bool() == Some(true) || spec["bold"].as_i64().unwrap_or(0) != 0;
        let value = face(name, bold).filter(|entry| entry["baselineOffsetEm"].as_f64().is_some() && entry["ratio"].as_f64().is_some_and(|ratio| ratio.is_finite() && ratio > 0.0)).map(|entry| json!({
            "face":name,"emScale":entry["ratio"],"baselineEm":entry["baselineOffsetEm"],
            "capEm":entry["inkAscEm"],"descEm":entry["inkDescEm"],"inkCenterEm":entry["inkCenterEm"],
        })).unwrap_or(Value::Null);
        results.insert(key, value);
    }
    Value::Object(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_legacy_font_geometry_for_all_bundled_subtitle_styles() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/socl-font-metrics.json")).unwrap();
        assert_eq!(metrics(&fixture["request"]), fixture["expected"]);
    }
    #[test]
    fn unknown_fonts_are_not_replaced_with_guessed_metrics() {
        assert_eq!(
            metrics(&json!([{"style":"bw","fn":"NonexistentFont"}])),
            json!({"bw|NonexistentFont":null})
        );
        assert_eq!(metrics(&Value::Null), json!({}));
    }
}
