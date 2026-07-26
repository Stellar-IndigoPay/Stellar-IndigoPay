#[cfg(test)]
mod test_recurring_slashing {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Address, Env};

    #[test]
    fn test_keeper_register_and_execute() {
        let env = Env::default();
        env.mock_all_auths();

        // Setup contract, token, donor, recipient, keeper
        let (client, token, donor, recipient, keeper) = setup_test_env(&env);
        let bond_amount = 10_000_000; // 10 XLM in stroops

        let rec_id = client.create_recurring(
            &donor,
            &recipient,
            &token.address,
            &100_000_000,
            &100,
            &1_000_000,
            &bond_amount,
        );

        // Keeper registers
        client.register_as_keeper(&keeper, &donor, &rec_id);

        // Fast forward ledger to maturity
        env.ledger().set_sequence(env.ledger().sequence() + 105);

        // Execute recurring
        client.execute_recurring(&keeper, &donor, &rec_id);

        // Verify bond returned and keeper incentive received
        assert_eq!(token.balance(&keeper), 100_000_000 + 1_000_000);
    }

    #[test]
    fn test_cannot_register_twice() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, token, donor, recipient, keeper1) = setup_test_env(&env);
        let keeper2 = Address::generate(&env);

        let rec_id = client.create_recurring(
            &donor, &recipient, &token.address, &100_000_000, &100, &1_000_000, &10_000_000,
        );

        client.register_as_keeper(&keeper1, &donor, &rec_id);

        // Second registration attempt should fail
        let res = client.try_register_as_keeper(&keeper2, &donor, &rec_id);
        assert_eq!(res, Err(Ok(ContractError::KeeperAlreadyRegistered)));
    }

    #[test]
    fn test_cannot_slash_before_grace_period() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, token, donor, recipient, keeper) = setup_test_env(&env);
        let slasher = Address::generate(&env);

        let rec_id = client.create_recurring(
            &donor, &recipient, &token.address, &100_000_000, &100, &1_000_000, &10_000_000,
        );

        client.register_as_keeper(&keeper, &donor, &rec_id);

        // Advance ledger past maturity but BEFORE grace period (e.g. +200 ledgers)
        env.ledger().set_sequence(env.ledger().sequence() + 200);

        let res = client.try_slash_keeper(&slasher, &donor, &rec_id);
        assert_eq!(res, Err(Ok(ContractError::GracePeriodNotExpired)));
    }

    #[test]
    fn test_keeper_slash_for_non_execution() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, token, donor, recipient, keeper) = setup_test_env(&env);
        let slasher = Address::generate(&env);
        let bond = 10_000_000;

        let rec_id = client.create_recurring(
            &donor, &recipient, &token.address, &100_000_000, &100, &1_000_000, &bond,
        );

        client.register_as_keeper(&keeper, &donor, &rec_id);

        // Advance ledger PAST maturity + grace period (100 + 720 + 1 = 821)
        env.ledger().set_sequence(env.ledger().sequence() + 825);

        client.slash_keeper(&slasher, &donor, &rec_id);

        // Slasher gets 50%, recipient gets 50%
        assert_eq!(token.balance(&slasher), 5_000_000);
        assert_eq!(token.balance(&recipient), 5_000_000);
    }

    #[test]
    fn test_keeper_bond_returned_on_cancel() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, token, donor, recipient, keeper) = setup_test_env(&env);
        let initial_keeper_bal = token.balance(&keeper);

        let rec_id = client.create_recurring(
            &donor, &recipient, &token.address, &100_000_000, &100, &1_000_000, &10_000_000,
        );

        client.register_as_keeper(&keeper, &donor, &rec_id);
        assert_eq!(token.balance(&keeper), initial_keeper_bal - 10_000_000);

        // Donor cancels recurring
        client.cancel_recurring(&donor, &rec_id);

        // Bond returned to keeper
        assert_eq!(token.balance(&keeper), initial_keeper_bal);
    }
}
