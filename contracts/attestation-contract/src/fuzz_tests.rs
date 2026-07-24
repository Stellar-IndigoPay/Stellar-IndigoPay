/// Property-based tests for attestation batch counter and indexing invariants.
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;

    use crate::{
        AttestationContract, AttestationContractClient, BatchAttestationInput, MAX_BATCH_SIZE,
    };
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, EnvTestConfig},
        Address, Env, String as SorobanString, Vec as SorobanVec,
    };

    // Batch invocations are substantially heavier than scalar properties.
    // Deterministic tests cover both boundaries, while these cases vary the
    // size, amounts, donor distribution, and transaction hashes.
    const PROPTEST_CASES: u32 = 32;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(PROPTEST_CASES))]

        #[test]
        fn prop_batch_counter_consistency(
            batch_size in 1u32..=MAX_BATCH_SIZE,
            seed in any::<u64>(),
            amount_usd in 1i128..=1_000_000_000i128,
            amount_xlm in 1i128..=10_000_000_000i128,
        ) {
            let env = Env::new_with_config(EnvTestConfig {
                capture_snapshot_at_drop: false,
            });
            env.mock_all_auths();
            let contract_id = env.register_contract(None, AttestationContract);
            let client = AttestationContractClient::new(&env, &contract_id);
            let admin = Address::generate(&env);
            let relayer = Address::generate(&env);
            let donors = [
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env),
            ];
            client.initialize(&admin);
            client.set_relayer(&admin, &relayer);

            let mut inputs = SorobanVec::new(&env);
            for index in 0..batch_size {
                let tx_hash = std::format!("0x{seed:016x}-{index:02}");
                inputs.push_back(BatchAttestationInput {
                    source_chain: SorobanString::from_str(&env, "ethereum"),
                    source_tx_hash: SorobanString::from_str(&env, &tx_hash),
                    donor: donors[(index % 3) as usize].clone(),
                    project_id: SorobanString::from_str(&env, "prop-project"),
                    amount_usd,
                    amount_xlm,
                    message_hash: index,
                });
            }

            let old_total = client.get_total_count();
            let old_pending = client.get_pending_count();
            let ids = client.record_attestation_batch(&relayer, &inputs);

            prop_assert_eq!(ids.len(), batch_size);
            prop_assert_eq!(
                client.get_total_count(),
                old_total + u64::from(batch_size)
            );
            prop_assert_eq!(
                client.get_pending_count(),
                old_pending + u64::from(batch_size)
            );

            for index in 0..batch_size {
                let expected_id = old_total + u64::from(index) + 1;
                let input = inputs.get(index).unwrap();
                prop_assert_eq!(ids.get(index).unwrap(), expected_id);
                let record = client.get_attestation(&expected_id);
                prop_assert_eq!(record.id, expected_id);
                prop_assert_eq!(record.source_tx_hash.clone(), input.source_tx_hash.clone());
                prop_assert_eq!(
                    client.get_attestation_by_source(
                        &input.source_chain,
                        &input.source_tx_hash
                    ),
                    Some(expected_id)
                );
            }

            let indexed_count = donors
                .iter()
                .map(|donor| client.get_by_donor(donor).len())
                .sum::<u32>();
            prop_assert_eq!(indexed_count, batch_size);
        }
    }
}
