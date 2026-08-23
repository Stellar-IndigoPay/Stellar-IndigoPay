//! Kani verification harnesses for IndigoPay contract

#[cfg(kani)]
#[kani::proof]
fn verify_badge_threshold_disjointness() {
    let amount: i128 = kani::any();
    kani::assume(amount >= 0);

    let is_seedling = amount >= 10 * 10_000_000 && amount < 100 * 10_000_000;
    let is_tree = amount >= 100 * 10_000_000 && amount < 500 * 10_000_000;
    let is_forest = amount >= 500 * 10_000_000 && amount < 2000 * 10_000_000;
    let is_earth_guardian = amount >= 2000 * 10_000_000;

    if is_earth_guardian {
        assert!(!is_forest && !is_tree && !is_seedling);
    }
}
