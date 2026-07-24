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
reporters, the fallback, and the global TWAP configuration:

```text
add_reporter(admin, reporter)
remove_reporter(admin, reporter)
set_fallback_price(admin, price)
set_max_price_deviation(admin, deviation_bps)
set_twap_window(admin, window)
set_staleness_threshold(admin, threshold)
get_twap_window()
get_staleness_threshold()
```

All setters require the admin's authorization. Fallback prices must be positive.
The TWAP window defaults to 10 observations and must be between 1 and 20. The
staleness threshold defaults to 720 ledgers and cannot be lower than the current
TWAP window. The reciprocal constraint also applies when changing the window.
Reporter changes emit `rep_add` and `rep_rem`. TWAP window updates emit topics
`("twap_win", admin)` with data `window: u32`; staleness threshold updates emit
topics `("stale_th", admin)` with data `threshold: u32`. Successful configuration
changes take effect on the next `get_price` call.

## Reporting and Aggregation

An authorised reporter submits a price with:

```text
report_price(reporter, raw_price)
```

The reporter must authorize the call and the price must be positive. When the
deviation circuit breaker is disabled or the report is within its configured
limit, the oracle records the raw price, reporter address, and current ledger
sequence (`ledger` field), and emits `price_upd`. A report rejected by the
circuit breaker is not stored and instead emits `price_rejected`.

The oracle stores at most 20 observations in a circular buffer. Once full, a new
report overwrites the oldest entry.

### Time-Weighted Average Price (TWAP)

`get_price()` computes a **Time-Weighted Average Price** using the configured
global window, which defaults to the newest 10 observations (or all available
when fewer observations exist). Unlike a simple arithmetic mean, TWAP weights
each observation by the number of ledgers it persisted before being replaced:

```
TWAP = Σ(price_i × weight_i) / (Σ(weight_i) × PRICE_SCALE)

where:
  weight_i = next_observation.ledger - current_observation.ledger
  (newest observation: current_ledger - newest.ledger)
```

**Edge cases:**
- **Same-ledger observations**: When multiple observations fall on the same
  ledger (e.g., rapid reporting), each receives a minimum weight of 1 so the
  result is equivalent to an arithmetic mean.
- **Single observation**: Weighted for the time elapsed since recording, so
  `get_price()` returns the observation's price regardless of elapsed time.

**Flash-loan resistance example:**

| Ledger | Observation | Weight | Contribution |
|--------|-------------|--------|-------------|
| 100 | price 10 | 10 | 100 |
| 200 | price 1000 (attacker) | 1 | 1000 |
| 201 (current) | — | — | — |

TWAP = (10×100 + 1000×1) / 101 = 19. The attack moved the price from 10 to 19 —
a 90% swing that's still far from the attacker's target of 1000.

## Freshness and Fallback Behavior

By default, the newest observation is valid through 720 ledgers after it was
recorded (approximately one hour at five seconds per ledger). The admin can
change this global threshold; a price becomes stale once its age exceeds the
configured value.

- `get_price()` returns the configured fallback price, if present.
- Without a fallback, it fails with `Oracle price is stale and no fallback configured`.

The freshness check uses the newest observation's ledger regardless of weight —
a stale observation always triggers the fallback.

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
