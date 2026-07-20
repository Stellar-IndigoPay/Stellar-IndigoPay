# IndigoPay Price Oracle

IndigoPay uses an on-chain oracle to convert USDC donation amounts into their XLM
equivalent. The oracle aggregates prices from multiple authorised reporters, keeps
a bounded history, and rejects stale market data.

## Price Format

Reporters submit a positive raw `i128` price scaled by `10^7`. For example, a raw
observation of `80_000_000` represents a rate of 8 XLM stroops per USDC stroop.
`get_price()` returns the scaled-down rate expected by `OracleInterface`.

The optional fallback is already expressed in the value returned by
`get_price()`. For example, configure `8` as the fallback for a rate of 8.

## Administration

Initialize the oracle once with `initialize(admin)`. The admin can then manage
reporters and the fallback:

```text
add_reporter(admin, reporter)
remove_reporter(admin, reporter)
set_fallback_price(admin, price)
```

All three operations require the admin's authorization. Fallback prices must be
positive. Reporter changes emit `rep_add` and `rep_rem` events.

## Reporting and Aggregation

An authorised reporter submits a price with:

```text
report_price(reporter, raw_price)
```

The reporter must authorize the call and the price must be positive. Each report
records the raw price, reporter address, and current ledger sequence, and emits a
`price_upd` event.

The oracle stores at most 20 observations in a circular buffer. Once full, a new
report overwrites the oldest entry. `get_price()` computes the arithmetic mean of
the newest 10 observations, or all available observations when fewer than 10
exist, then divides it by `10^7`.

## Freshness and Fallback Behavior

The newest observation is valid through 720 ledgers after it was recorded
(approximately one hour at five seconds per ledger). At ledger 721 and later:

- `get_price()` returns the configured fallback price, if present.
- Without a fallback, it fails with `Oracle price is stale and no fallback configured`.

When there are no observations, `get_price()` also returns the configured
fallback. Without either observations or a fallback, it fails with
`Oracle has no observations and no fallback`.

The fallback is an operational safety mechanism, not another live source. Admins
should choose it conservatively and update it through their normal governance
process.

## IndigoPay Integration

The oracle preserves the existing interface:

```rust
fn get_price(env: Env) -> i128;
```

After deployment, the IndigoPay admin registers the oracle contract with
`set_oracle(admin, oracle_address)`. `donate_usdc` then calls `get_price()` during
conversion; stale data without a fallback causes the donation transaction to
fail instead of silently using an invalid rate.
