use indigopay_contract::DataKey;
use soroban_sdk::xdr::{Limits, ReadXdr, ScSpecEntry, ScSpecTypeDef, ScSpecUdtUnionCaseV0};

const GOLDEN: &str = include_str!("../DataKey.discriminants.txt");

fn parse_representation(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

fn payload_type_name(type_def: &ScSpecTypeDef) -> String {
    match type_def {
        ScSpecTypeDef::BytesN(bytes_n) => format!("BytesN<{}>", bytes_n.n),
        ScSpecTypeDef::Udt(udt) => udt.name.to_utf8_string_lossy(),
        _ => type_def.name().to_owned(),
    }
}

fn current_representation() -> Vec<String> {
    let entry = ScSpecEntry::from_xdr(DataKey::spec_xdr(), Limits::none())
        .expect("DataKey::spec_xdr() must contain valid ScSpecEntry XDR");
    let union = match entry {
        ScSpecEntry::UdtUnionV0(union) => union,
        entry => panic!("expected DataKey to generate a UdtUnionV0, got {entry:?}"),
    };

    assert_eq!(
        union.name.to_utf8_string_lossy(),
        "DataKey",
        "the generated spec must describe DataKey"
    );

    union
        .cases
        .iter()
        .enumerate()
        .map(|(index, case)| {
            let (name, payload) = match case {
                ScSpecUdtUnionCaseV0::VoidV0(case) => {
                    (case.name.to_utf8_string_lossy(), String::new())
                }
                ScSpecUdtUnionCaseV0::TupleV0(case) => {
                    let payload = case
                        .type_
                        .iter()
                        .map(payload_type_name)
                        .collect::<Vec<_>>()
                        .join(", ");
                    (case.name.to_utf8_string_lossy(), format!("({payload})"))
                }
            };
            format!("{index} {name}{payload}")
        })
        .collect()
}

fn is_complete(golden: &[String], current: &[String]) -> bool {
    golden == current
}

fn is_append_only(baseline: &[String], current: &[String]) -> bool {
    current.len() >= baseline.len()
        && baseline
            .iter()
            .zip(current)
            .all(|(expected, actual)| actual == expected)
}

fn assert_complete(golden: &[String], current: &[String]) {
    assert!(
        is_complete(golden, current),
        "DataKey.discriminants.txt must exactly represent the complete current DataKey definition"
    );
}

fn assert_append_only(baseline: &[String], current: &[String]) {
    assert!(
        is_append_only(baseline, current),
        "DataKey changed before the end of the historical baseline; existing cases must stay in order"
    );
}

fn assert_unique_variant_names(representation: &[String]) {
    let mut names = Vec::new();
    for entry in representation {
        let name = entry
            .split_once(' ')
            .map(|(_, name_and_payload)| name_and_payload.split('(').next().unwrap())
            .expect("each DataKey representation must contain an index and name");
        assert!(
            !names.iter().any(|known| known == &name),
            "DataKey contains duplicate variant name {name:?}"
        );
        names.push(name.to_owned());
    }
}

#[test]
fn data_key_generated_representation_is_append_only_compatible() {
    let current = current_representation();

    if std::env::var_os("DATA_KEY_PRINT_REPRESENTATION").is_some() {
        println!("DATA_KEY_BASELINE_BEGIN");
        println!("{}", current.join("\n"));
        println!("DATA_KEY_BASELINE_END");
        return;
    }

    let golden = parse_representation(GOLDEN);

    assert!(!golden.is_empty(), "DataKey golden representation is empty");
    assert_unique_variant_names(&current);
    assert_complete(&golden, &current);

    // CI supplies the golden representation from the base commit. Unlike the
    // current golden file, this historical value cannot be regenerated in the
    // same change as an enum mutation.
    if let Ok(baseline) = std::env::var("DATA_KEY_GOLDEN_BASELINE") {
        let baseline = parse_representation(&baseline);
        assert!(!baseline.is_empty(), "DataKey historical baseline is empty");
        assert_append_only(&baseline, &current);
    }
}

#[test]
fn complete_comparison_rejects_an_unrecorded_append() {
    let golden = parse_representation("0 A\n1 B\n");
    let current = parse_representation("0 A\n1 B\n2 C\n");

    assert!(!is_complete(&golden, &current));
}

#[test]
fn appended_variant_passes_when_the_complete_golden_is_updated() {
    let baseline = parse_representation("0 A\n1 B\n");
    let updated_golden = parse_representation("0 A\n1 B\n2 C\n");

    assert!(is_complete(&updated_golden, &updated_golden));
    assert!(is_append_only(&baseline, &updated_golden));
}

#[test]
fn historical_comparison_rejects_insertion_reordering_deletion_and_changed_index() {
    let baseline = parse_representation("0 A\n1 B\n2 C\n");
    let incompatible = [
        "0 A\n1 X\n2 B\n3 C\n", // insertion in the middle
        "0 A\n1 C\n2 B\n",      // reordering
        "0 A\n1 B\n",           // deletion
        "0 A\n1 B\n3 C\n",      // changed effective index
    ];

    for candidate in incompatible {
        let current = parse_representation(candidate);
        assert!(
            !is_append_only(&baseline, &current),
            "fixture should be incompatible: {candidate:?}"
        );
    }
}

#[test]
fn regenerating_the_golden_cannot_legitimize_a_middle_insertion() {
    let baseline = parse_representation("0 A\n1 B\n2 C\n");
    let regenerated_golden = parse_representation("0 A\n1 X\n2 B\n3 C\n");

    // An exact-equality-only guard would accept this regenerated file. The
    // base-commit comparison still rejects the incompatible insertion.
    assert!(is_complete(&regenerated_golden, &regenerated_golden));
    assert!(!is_append_only(&baseline, &regenerated_golden));
}

#[test]
fn historical_comparison_rejects_payload_shape_changes() {
    let baseline = parse_representation("0 A\n1 B(String)\n");
    let current = parse_representation("0 A\n1 B(Address)\n");

    assert!(!is_append_only(&baseline, &current));
}
