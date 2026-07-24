# Oracle Contract Security Model

## Reporter staking and slashing (#446)

Reporter staking is an economic supplement to the oracle allow-list. An
address must remain allow-listed and hold at least the configured `min_stake`
before `report_price` accepts its observations.

The administrator configures one staking token, a minimum stake, a treasury,
and an unstaking cooldown. Deposits reset the reporter's cooldown. After the
cooldown, `unstake` withdraws the reporter's entire remaining balance, which
also prevents further reporting until the reporter stakes again.

Slashing is an explicit administrator action. The contract does not
automatically decide whether an observation was malicious. A slash:

1. reduces the reporter's stored stake;
2. appends an immutable reason, amount, and ledger to slash history;
3. transfers the slashed tokens to the configured treasury.

All stake mutations follow checks-effects-interactions ordering. Soroban
transaction atomicity reverts the preceding storage changes if a token
transfer fails.

### Trust assumptions

- The administrator is trusted to configure the staking asset and treasury
  correctly and to slash only with documented evidence.
- Token behavior and balances are enforced by the configured Stellar asset
  contract.
- Slashing is capped at the reporter's current stake, so stored stake cannot
  become negative.
- Reconfiguration does not rewrite reporter balances or slash history.

