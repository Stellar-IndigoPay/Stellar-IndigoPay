// Fuzz tests and aggregate helper unit tests
#[cfg(test)]
mod tests {
    use super::super::*;
    use proptest::prelude::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, String};

    #[test]
    fn test_aggregate_helpers_direct_record() {
        let env = Env::default();
        let id = env.register_contract(None, AttestationContract);
        let donor = Address::generate(&env);
        let eth = String::from_str(&env, "ethereum");
        let poly = String::from_str(&env, "polygon");

        env.as_contract(&id, || {
            // ─── 0 Attestations Case ───
            let donor_agg_0 = read_donor_aggregate(&env, &donor);
            assert_eq!(donor_agg_0.total_attestations, 0);
            assert_eq!(donor_agg_0.total_usd, 0);
            assert_eq!(donor_agg_0.total_xlm, 0);
            assert_eq!(donor_agg_0.pending, 0);
            assert_eq!(donor_agg_0.verified, 0);
            assert_eq!(donor_agg_0.revoked, 0);
            assert_eq!(donor_agg_0.chains.len(), 0);

            let chain_agg_0 = read_chain_aggregate(&env, &eth);
            assert_eq!(chain_agg_0.total_attestations, 0);
            assert_eq!(chain_agg_0.total_usd, 0);
            assert_eq!(chain_agg_0.total_xlm, 0);
            assert_eq!(chain_agg_0.pending, 0);
            assert_eq!(chain_agg_0.verified, 0);
            assert_eq!(chain_agg_0.revoked, 0);

            // ─── 1 Attestation Case ───
            update_aggregates_on_record(&env, &donor, &eth, 10_000_000i128, 80_000_000i128);

            let donor_agg_1 = read_donor_aggregate(&env, &donor);
            assert_eq!(donor_agg_1.total_attestations, 1);
            assert_eq!(donor_agg_1.total_usd, 10_000_000);
            assert_eq!(donor_agg_1.total_xlm, 80_000_000);
            assert_eq!(donor_agg_1.pending, 1);
            assert_eq!(donor_agg_1.chains.len(), 1);
            let cc = donor_agg_1.chains.get(0).unwrap();
            assert_eq!(cc.chain, eth);
            assert_eq!(cc.count, 1);

            let chain_agg_1 = read_chain_aggregate(&env, &eth);
            assert_eq!(chain_agg_1.total_attestations, 1);
            assert_eq!(chain_agg_1.total_usd, 10_000_000);
            assert_eq!(chain_agg_1.total_xlm, 80_000_000);
            assert_eq!(chain_agg_1.pending, 1);

            // ─── Multiple Attestations Case (Same Chain) ───
            update_aggregates_on_record(&env, &donor, &eth, 5_000_000i128, 40_000_000i128);

            let donor_agg_2 = read_donor_aggregate(&env, &donor);
            assert_eq!(donor_agg_2.total_attestations, 2);
            assert_eq!(donor_agg_2.total_usd, 15_000_000);
            assert_eq!(donor_agg_2.total_xlm, 120_000_000);
            assert_eq!(donor_agg_2.pending, 2);
            assert_eq!(donor_agg_2.chains.len(), 1);
            let cc2 = donor_agg_2.chains.get(0).unwrap();
            assert_eq!(cc2.chain, eth);
            assert_eq!(cc2.count, 2);

            let chain_agg_2 = read_chain_aggregate(&env, &eth);
            assert_eq!(chain_agg_2.total_attestations, 2);
            assert_eq!(chain_agg_2.total_usd, 15_000_000);
            assert_eq!(chain_agg_2.total_xlm, 120_000_000);
            assert_eq!(chain_agg_2.pending, 2);

            // ─── Multiple Attestations Case (Different Chain) ───
            update_aggregates_on_record(&env, &donor, &poly, 4_000_000i128, 32_000_000i128);

            let donor_agg_3 = read_donor_aggregate(&env, &donor);
            assert_eq!(donor_agg_3.total_attestations, 3);
            assert_eq!(donor_agg_3.total_usd, 19_000_000);
            assert_eq!(donor_agg_3.total_xlm, 152_000_000);
            assert_eq!(donor_agg_3.chains.len(), 2);

            let mut found_eth = false;
            let mut found_poly = false;
            for i in 0..donor_agg_3.chains.len() {
                let cc = donor_agg_3.chains.get(i).unwrap();
                if cc.chain == eth {
                    assert_eq!(cc.count, 2);
                    found_eth = true;
                } else if cc.chain == poly {
                    assert_eq!(cc.count, 1);
                    found_poly = true;
                }
            }
            assert!(found_eth);
            assert!(found_poly);

            let chain_agg_poly = read_chain_aggregate(&env, &poly);
            assert_eq!(chain_agg_poly.total_attestations, 1);
            assert_eq!(chain_agg_poly.total_usd, 4_000_000);
            assert_eq!(chain_agg_poly.total_xlm, 32_000_000);
        });
    }

    #[test]
    fn test_aggregate_helpers_direct_verify_and_revoke() {
        let env = Env::default();
        let id = env.register_contract(None, AttestationContract);
        let donor = Address::generate(&env);
        let eth = String::from_str(&env, "ethereum");

        env.as_contract(&id, || {
            // Record two pending
            update_aggregates_on_record(&env, &donor, &eth, 10_000_000i128, 80_000_000i128);
            update_aggregates_on_record(&env, &donor, &eth, 20_000_000i128, 160_000_000i128);

            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 2);
            assert_eq!(agg.verified, 0);
            assert_eq!(agg.revoked, 0);

            // Verify 1
            update_aggregates_on_verify(&env, &donor, &eth);
            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 1);
            assert_eq!(agg.verified, 1);

            // Verify 2
            update_aggregates_on_verify(&env, &donor, &eth);
            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 0);
            assert_eq!(agg.verified, 2);

            // Revoke 1 (was_pending = false, i.e., verified)
            update_aggregates_on_revoke(&env, &donor, &eth, false);
            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 0);
            assert_eq!(agg.verified, 1);
            assert_eq!(agg.revoked, 1);

            // Record third and revoke (was_pending = true, i.e., pending)
            update_aggregates_on_record(&env, &donor, &eth, 5_000_000i128, 40_000_000i128);
            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 1);
            assert_eq!(agg.verified, 1);
            assert_eq!(agg.revoked, 1);

            update_aggregates_on_revoke(&env, &donor, &eth, true);
            let agg = read_donor_aggregate(&env, &donor);
            assert_eq!(agg.pending, 0);
            assert_eq!(agg.verified, 1);
            assert_eq!(agg.revoked, 2);

            // Double check chain totals too
            let chain_agg = read_chain_aggregate(&env, &eth);
            assert_eq!(chain_agg.total_attestations, 3);
            assert_eq!(chain_agg.total_usd, 35_000_000);
            assert_eq!(chain_agg.total_xlm, 280_000_000);
            assert_eq!(chain_agg.pending, 0);
            assert_eq!(chain_agg.verified, 1);
            assert_eq!(chain_agg.revoked, 2);
        });
    }

    #[test]
    fn test_donor_project_filtering_and_custom_queries() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AttestationContract);
        let client = AttestationContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);

        client.initialize(&admin);
        client.set_relayer(&admin, &relayer);

        let eth = String::from_str(&env, "ethereum");
        let proj1 = String::from_str(&env, "proj-1");
        let proj2 = String::from_str(&env, "proj-2");

        // Record various attestations across projects and donors
        client.record_attestation(
            &relayer,
            &eth,
            &String::from_str(&env, "0x01"),
            &donor_a,
            &proj1,
            &1_000_000i128,
            &8_000_000i128,
            &0,
        );
        client.record_attestation(
            &relayer,
            &eth,
            &String::from_str(&env, "0x02"),
            &donor_a,
            &proj2,
            &2_000_000i128,
            &16_000_000i128,
            &0,
        );
        client.record_attestation(
            &relayer,
            &eth,
            &String::from_str(&env, "0x03"),
            &donor_b,
            &proj1,
            &3_000_000i128,
            &24_000_000i128,
            &0,
        );
        client.record_attestation(
            &relayer,
            &eth,
            &String::from_str(&env, "0x04"),
            &donor_a,
            &proj1,
            &4_000_000i128,
            &32_000_000i128,
            &0,
        );

        // Retrieve all attestations for donor_a
        let attestations_a = client.get_by_donor(&donor_a);
        assert_eq!(attestations_a.len(), 3);

        // Filter by project-1 and aggregate sum and count
        let mut sum_usd_proj1 = 0;
        let mut sum_xlm_proj1 = 0;
        let mut count_proj1 = 0;
        for i in 0..attestations_a.len() {
            let att = attestations_a.get(i).unwrap();
            if att.project_id == proj1 {
                sum_usd_proj1 += att.amount_usd;
                sum_xlm_proj1 += att.amount_xlm;
                count_proj1 += 1;
            }
        }
        assert_eq!(sum_usd_proj1, 5_000_000);
        assert_eq!(sum_xlm_proj1, 40_000_000);
        assert_eq!(count_proj1, 2);

        // Filter by project-2
        let mut sum_usd_proj2 = 0;
        let mut count_proj2 = 0;
        for i in 0..attestations_a.len() {
            let att = attestations_a.get(i).unwrap();
            if att.project_id == proj2 {
                sum_usd_proj2 += att.amount_usd;
                count_proj2 += 1;
            }
        }
        assert_eq!(sum_usd_proj2, 2_000_000);
        assert_eq!(count_proj2, 1);

        // For donor_b and project-1
        let attestations_b = client.get_by_donor(&donor_b);
        assert_eq!(attestations_b.len(), 1);
        let att_b = attestations_b.get(0).unwrap();
        assert_eq!(att_b.project_id, proj1);
        assert_eq!(att_b.amount_usd, 3_000_000);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        #[test]
        fn prop_aggregate_math_consistency(
            usd1 in 1i128..=1_000_000_000,
            xlm1 in 1i128..=1_000_000_000,
            usd2 in 1i128..=1_000_000_000,
            xlm2 in 1i128..=1_000_000_000,
        ) {
            let env = Env::default();
            let id = env.register_contract(None, AttestationContract);
            let donor = Address::generate(&env);
            let chain = String::from_str(&env, "ethereum");

            env.as_contract(&id, || {
                // Direct update 1
                update_aggregates_on_record(&env, &donor, &chain, usd1, xlm1);
                let agg1 = read_donor_aggregate(&env, &donor);
                prop_assert_eq!(agg1.total_attestations, 1);
                prop_assert_eq!(agg1.total_usd, usd1);
                prop_assert_eq!(agg1.total_xlm, xlm1);
                prop_assert_eq!(agg1.pending, 1);

                // Direct update 2
                update_aggregates_on_record(&env, &donor, &chain, usd2, xlm2);
                let agg2 = read_donor_aggregate(&env, &donor);
                prop_assert_eq!(agg2.total_attestations, 2);
                prop_assert_eq!(agg2.total_usd, usd1 + usd2);
                prop_assert_eq!(agg2.total_xlm, xlm1 + xlm2);
                prop_assert_eq!(agg2.pending, 2);

                let chain_agg = read_chain_aggregate(&env, &chain);
                prop_assert_eq!(chain_agg.total_attestations, 2);
                prop_assert_eq!(chain_agg.total_usd, usd1 + usd2);
                prop_assert_eq!(chain_agg.total_xlm, xlm1 + xlm2);
                prop_assert_eq!(chain_agg.pending, 2);
                Ok(())
            })?;
        }
    }
}
