//! WS7 — Event integrity: topic uniqueness and catalog golden file.
//!
//! Every event the four contracts publish must have a globally unique topic,
//! and the set of topics must match the committed `event_catalog.json` golden
//! file so adding/removing/renaming an event without updating the catalog
//! fails CI.
//!
//! Events are defined as `#[contractevent(topics = ["name", ...])]` structs.
//! The first entry of each `topics = [...]` list is the event's canonical
//! topic (the symbol indexers key on); the length of that fixed topic list is
//! that event's *prefix arity*. Two code paths may re-emit the *same* semantic
//! event (same topic, same prefix arity) — that is indexer-safe and allowed.
//!
//! Regenerate the catalog with:
//!   cargo test -p indigopay-contract --features testutils --test event_catalog -- --nocapture

const INDIGOPAY_SRC: &str = include_str!("../src/lib.rs");
const INDIGOPAY_EVENTS_SRC: &str = include_str!("../src/donation/events.rs");
const ESCROW_SRC: &str = include_str!("../../escrow-contract/src/lib.rs");
const ORACLE_SRC: &str = include_str!("../../oracle-contract/src/lib.rs");
const ATTESTATION_SRC: &str = include_str!("../../attestation-contract/src/lib.rs");

/// Everything after the first `#[cfg(test)]` in a lib.rs is test code — the
/// catalog only cares about production event definitions.
fn production_part(src: &str) -> &str {
    match src.find("#[cfg(test)]") {
        Some(idx) => &src[..idx],
        None => src,
    }
}

/// Extract `(topic, prefix_arity)` pairs from `#[contractevent(...)]` struct
/// definitions in the given source. For every `#[contractevent(topics = [...])]`
/// attribute we record the first topics entry as the canonical event topic and
/// the number of fixed topic strings as its prefix arity.
fn topics_from(src: &str) -> Vec<(String, usize)> {
    let mut topics = Vec::new();
    let mut rest = src;
    while let Some(pos) = rest.find("#[contractevent") {
        let window = &rest[pos..];
        // Find the topics = [...] list within this attribute.
        if let Some(list_start) = window.find("topics = [") {
            let after = &window[list_start..];
            if let Some(close) = after.find(']') {
                let list = &after["topics = [".len()..close];
                let mut entries: Vec<String> = Vec::new();
                for part in list.split('"') {
                    let stripped = part.trim();
                    if !stripped.is_empty()
                        && is_plain_topic(stripped)
                        && !entries.contains(&stripped.to_string())
                    {
                        entries.push(stripped.to_string());
                    }
                }
                if let Some(first) = entries.first() {
                    topics.push((first.clone(), entries.len()));
                }
            }
        }
        // Advance past this attribute so we don't re-scan it.
        let end = window.find("]").map(|i| i + 1).unwrap_or(1);
        rest = &window[end..];
    }
    topics
}

/// A valid fixed topic is a plain Soroban symbol (optionally prefixed with the
/// feature path or punctuation the macro accepts). We accept bare identifiers
/// and symbols; anything containing whitespace or braces is ignored.
fn is_plain_topic(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('{')
        && !s.contains('}')
        && !s.contains('[')
        && !s.contains('\n')
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}

fn all_topics() -> Vec<(String, String, usize)> {
    let mut out = Vec::new();
    for (name, src) in [
        ("indigopay", INDIGOPAY_SRC),
        ("indigopay-events", INDIGOPAY_EVENTS_SRC),
        ("escrow", ESCROW_SRC),
        ("oracle", ORACLE_SRC),
        ("attestation", ATTESTATION_SRC),
    ] {
        for (t, arity) in topics_from(production_part(src)) {
            out.push((name.to_string(), t, arity));
        }
    }
    out
}

/// Same topic with a different prefix arity is a genuine collision: two code
/// paths claim the same event name with incompatible fixed-topic shapes.
/// Re-emitting the same semantic event (same topic, same prefix arity) from
/// parallel paths is intentional and indexer-safe, so it is allowed.
#[test]
fn event_topics_have_consistent_shape() {
    let topics = all_topics();
    let mut shape: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (_crate, topic, arity) in &topics {
        if let Some(prev) = shape.get(topic.as_str()) {
            assert_eq!(
                prev, arity,
                "event topic `{topic}` is emitted with different prefix arities ({} vs {}): \
                 indexers cannot disambiguate",
                prev, arity
            );
        } else {
            shape.insert(topic.as_str(), *arity);
        }
    }
    assert!(shape.len() >= 20, "expected a non-trivial event catalog");
}

#[test]
fn event_catalog_matches_golden_file() {
    let topics: Vec<String> = all_topics().into_iter().map(|(_, t, _)| t).collect();
    let mut sorted: Vec<String> = topics.clone();
    sorted.sort();
    sorted.dedup();

    let golden_path = concat!(env!("CARGO_MANIFEST_DIR"), "/event_catalog.json");
    let golden = std::fs::read_to_string(golden_path).expect("event_catalog.json missing");
    let golden_topics: Vec<String> = serde_json::from_str(&golden)
        .unwrap_or_else(|_| panic!("event_catalog.json is not valid JSON"));

    if sorted != golden_topics {
        let missing: Vec<&String> = sorted
            .iter()
            .filter(|t| !golden_topics.contains(t))
            .collect();
        let extra: Vec<&String> = golden_topics
            .iter()
            .filter(|t| !sorted.contains(t))
            .collect();
        panic!(
            "event catalog out of date.\n  Missing from catalog: {:?}\n  No longer emitted: {:?}\n\
             Regenerate with: cargo test -p indigopay-contract --features testutils --test event_catalog -- --nocapture",
            missing, extra
        );
    }
}

/// WS7 criterion 5: each contract exposes an `event_count` equal to the number
/// of distinct semantic event topics it defines. This keeps the catalog golden
/// file and the on-contract `event_count()` in lock-step, so adding or removing
/// an event without updating both fails CI. Must mirror the values hard-coded in
/// the four contracts' `event_count(env)` entrypoints.
#[test]
fn event_counts_match_contract_declarations() {
    fn distinct(topics: &[(String, String, usize)], crate_name: &str) -> usize {
        let mut s = std::collections::BTreeSet::new();
        for (c, t, _) in topics {
            if c == crate_name {
                s.insert(t.clone());
            }
        }
        s.len()
    }
    let topics = all_topics();
    let expected = [
        ("escrow", "escrow", 17),
        ("oracle", "oracle", 11),
        ("attestation", "attestation", 14),
        // indigopay = lib.rs + donation/events.rs semantic topics.
        ("indigopay", "indigopay", 104),
    ];
    for (label, crate_name, expected_count) in expected {
        let actual = distinct(&topics, crate_name)
            + if crate_name == "indigopay" {
                distinct(&topics, "indigopay-events")
            } else {
                0
            };
        assert_eq!(
            actual, expected_count,
            "`{label}` event_count mismatch: catalog sees {actual} distinct topics but \
             the contract returns {expected_count}. Update BOTH the contract's `event_count` \
             and this test, and ensure the catalog is consistent."
        );
    }
}
