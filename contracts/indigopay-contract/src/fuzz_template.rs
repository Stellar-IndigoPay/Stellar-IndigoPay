/// fuzz_template.rs — Reusable fuzz-test template for IndigoPay contract
/// contributors.
///
/// Use this template as a starting point when adding fuzz tests for new
/// state-mutating functions. Each fuzz test should:
///
/// 1. Define a property / invariant (something that must ALWAYS be true).
/// 2. Generate random inputs within sensible bounds using `proptest`
///    strategies.
/// 3. Assert the invariant holds under random perturbations.
///
/// # Adding a fuzz test for a new function
///
/// 1. Copy the `fn fuzz_<your_function_name>` block below into
///    `fuzz_tests.rs` inside the `proptest! { ... }` macro.
/// 2. Replace the dummy inputs with strategies that match your function's
///    parameter types.
/// 3. Write at least one invariant assertion.
///
/// # Invariant checklist
///
/// Before you add a new fuzz test, check which invariants apply:
///
/// - [ ] Global counters (total_raised, co2) never decrease
/// - [ ] Per-project totals never decrease
/// - [ ] Donation counts are monotonic
/// - [ ] Badge tiers only upgrade
/// - [ ] Active/inactive/paused state transitions are valid
/// - [ ] Duplicate operations (same donor, same project) are handled
/// - [ ] Arithmetic bounds: no silent overflow
/// - [ ] Admin-only functions reject non-admin callers
/// - [ ] Pause-gated functions reject when contract is paused
///
/// # Input generation patterns
///
/// Common `proptest` strategies useful for Soroban contracts:
///
/// ```ignore
/// // i128 amounts bounded to avoid overflow-induced panics
/// let amount = 1i128..=1_000_000_000_000_000i128;
///
/// // u32 bounded enums / counters
/// let counter = 0u32..=1_000_000u32;
///
/// // bool for approve/reject, pause/unpause, etc.
/// let flag = proptest::bool::ANY;
///
/// // Fixed-size byte arrays (for hashes, addresses)
/// let bytes: [u8; 32] = proptest::array::uniform32(proptest::num::u8::ANY);
///
/// // Strings (project IDs, names)
/// let string = "[a-z0-9-]{1,32}"; // regex strategy
/// ```
///
/// Run:
///   cargo test --features testutils -- fuzz
///   FUZZ_ITERATIONS=100000 cargo test --features testutils -- fuzz
///
/// This file is a documentation template; it is NOT compiled as part of the
/// contract. Reference patterns live in `fuzz_tests.rs` alongside the
/// concrete fuzz implementations.
///
/// Fuzz-test template for any new state-mutating function.
///
/// Replace `your_function_name` and the strategy ranges with real values.
///
/// # Example
///
/// ```ignore
/// proptest! {
///     // Include the CI-configurable iteration count
///     #![proptest_config(fuzz_config())]
///
///     /// INVARIANT: <describe the invariant here>
///     #[test]
///     fn fuzz_your_function_name(
///         input_a in 1i128..=1_000_000i128,
///         input_b in 0u32..=100u32,
///     ) {
///         // 1. Arrange
///         let (env, admin, client, project_id) = setup_with_admin();
///         // ... set up any additional state needed ...
///
///         // 2. Act — wrap in catch_unwind if the function may panic
///         //    on some inputs (e.g. overflow guards).
///         let result = std::panic::catch_unwind(
///             std::panic::AssertUnwindSafe(|| {
///                 client.your_function(&admin, &project_id, &input_a, &input_b);
///             })
///         );
///
///         // 3. Assert
///         // If the function is expected to always succeed:
///         prop_assert!(result.is_ok(), "your_function should not panic");
///
///         // If certain inputs should cause a panic:
///         // prop_assert!(result.is_err(), "your_function should panic for ...");
///
///         // Read state and check invariants:
///         let project = client.get_project(&project_id);
///         prop_assert!(project.total_raised >= 0);
///     }
/// }
/// ```
///
/// Recommended patterns for common fuzz scenarios:
///
/// ## Overflow safety
///
/// ```ignore
/// #[test]
/// fn fuzz_overflow_boundaries(
///     amount in (i128::MAX - 1000)..=i128::MAX,
/// ) {
///     let (env, admin, client, project_id) = setup_with_admin();
///     // Function should panic or handle gracefully near i128::MAX
/// }
/// ```
///
/// ## Repeated calls (idempotency)
///
/// ```ignore
/// #[test]
/// fn fuzz_repeated_calls(
///     amount in 1i128..=1_000_000i128,
///     repeat in 1u32..=10u32,
/// ) {
///     // Call the function `repeat` times and ensure invariants hold
/// }
/// ```
///
/// ## State transition sequences
///
/// ```ignore
/// #[test]
/// fn fuzz_transition_sequence(
///     pause_before in proptest::bool::ANY,
///     deactivate_before in proptest::bool::ANY,
///     amount in 1i128..=1_000_000i128,
/// ) {
///     // Test sequences: pause → donate, deactivate → donate, etc.
/// }
/// ```
#[allow(dead_code)]
pub struct FuzzTemplate;
// ^ Dummy type so the file compiles as a module. Contributors can delete this
//   when they add real fuzz tests below.
