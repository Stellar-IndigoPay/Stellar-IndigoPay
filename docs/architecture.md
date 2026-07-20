# Architecture — Stellar-IndigoPay

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User's Browser                             │
│  ┌────────────────────────────┐   ┌────────────────────────────┐   │
│  │  Next.js Frontend          │   │  Freighter Extension       │   │
│  │  (React + Tailwind)        │◄─►│  (Stellar Wallet)          │   │
│  └──────────┬─────────────────┘   └────────────────────────────┘   │
└─────────────┼───────────────────────────────────────────────────────┘
              │ REST API (non-critical path)
              ▼
┌─────────────────────────────┐
│  Node.js Backend (Express)  │
│                             │
│  • Project metadata         │
│  • Donation record keeping  │
│  • Leaderboard aggregation  │
│  • Profile management       │
│  • Project updates feed     │
└──────────────┬──────────────┘
               │ Horizon REST
               ▼
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  Stellar Horizon API        │◄───►│  Stellar Network             │
│  (horizon-testnet           │     │  (Validators)                │
│   .stellar.org)             │     │                              │
└─────────────────────────────┘     └──────────────────────────────┘
                                               ▲
                                               │ Soroban
                                  ┌────────────────────────────────┐
                                  │  IndigoPay Donation Contract    │
                                  │  (Rust/WASM)                   │
                                  │                                │
                                  │  register_project()            │
                                  │  donate()                      │
                                  │  get_donor_stats()             │
                                  │  get_badge()                   │
                                  │  get_global_total()            │
                                  │  get_global_co2()              │
                                  └────────────────────────────────┘
```

## Donation Flow

```
Donor selects amount ──► buildDonationTransaction()
                                    │
                                    ▼
                         Freighter signs tx
                                    │
                                    ▼
                    submitTransaction() → Horizon
                                    │
                                    ▼
                    XLM sent directly to project wallet
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
              recordDonation()           Soroban donate()
              (backend)                  (on-chain record)
                        │                       │
                        └───────────┬───────────┘
                                    ▼
                        Leaderboard + badge updated
```

## Key Design Decisions

### Direct-to-project payments

Donations go straight to the project wallet via a standard Stellar payment. The contract records the event but does not custody funds — this maximises trust and minimises attack surface.

### Backend as optional layer

The Node.js backend provides project metadata, the leaderboard, and the update feed. If the backend is unavailable, core donations still work — users just can't see the leaderboard or feed.

### Soroban as the source of truth

The contract is the immutable, auditable record of all donations. Anyone can verify total raised, donor stats, and CO₂ offsets without trusting the backend.

### Community features

The leaderboard and donation feed create social accountability — donors can see their rank and impact publicly, encouraging more giving.

## Automated CO₂ Offset Rate Verification

The platform includes an automated, data-driven pipeline that verifies project-reported CO₂ offset rates against independent scientific databases and satellite-based biomass estimation.

### Verification Pipeline

```
Project registered ──► verifyProjectCO2Rate(project)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            fetchReferenceRates()   fetchSatelliteEstimate()
            (Gold Standard, Verra,  (Global Forest Watch API,
             IPCC fallback)          IPCC tier-1 fallback)
                    │                       │
                    └───────────┬───────────┘
                                ▼
                    computeConfidenceBand()
                    [lower, upper] g CO₂/XLM
                                │
                                ▼
                    computeSeverity()
                    none / warning / critical
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          co2_verification_runs     projects.co2_verification_status
          (audit history)           (updated if implausible)
```

### Reference Rate Sources (highest priority first)

1. **Gold Standard Impact Registry API** — `CO2_VERIFIER_GS_API_URL` env var
2. **Verra VCS Registry** — `CO2_VERIFIER_VERRA_API_URL` env var
3. **IndigoPay Category Benchmarks** — static per-category rates based on IPCC-informed literature
4. **IPCC Tier-1 Emission Factors** — universal fallback using 2006 IPCC Guidelines

### Satellite Data Integration

For reforestation and land-use projects, the pipeline queries:
- **Global Forest Watch API (WRI)** — requires `CO2_VERIFIER_GFW_API_URL` and `CO2_VERIFIER_GFW_API_KEY`
- **IPCC Tier-1 biomass factors** — selected by climate zone (tropical/temperate/boreal) based on latitude

Satellite-derived estimates are converted from tCO₂/ha/yr to g CO₂/XLM and used to tighten the confidence band's upper bound.

### Confidence Band & Severity

| Severity   | Condition                             | Admin Action      |
| ---------- | ------------------------------------- | ----------------- |
| none       | rate ≤ upper × 1.5                    | None (plausible)  |
| warning    | rate > upper × 1.5 and ≤ upper × 3.0 | Review required   |
| critical   | rate > upper × 3.0                    | Flagged for admin |

### Scheduled Verification

A pg-boss cron job (configurable via `CO2_VERIFICATION_CRON`, default: weekly Sunday 03:00 UTC) re-verifies all active projects. Each run writes a row to `co2_verification_runs` for audit trail. The Prometheus counter `indigopay_co2_verifications_total` tracks outcomes.

### Admin & User Surface

- **Admin CO₂ Flags Dashboard** (`/admin/co2-flags`): shows confidence bands, deviation %, reference source, and severity. Admins can trigger re-verification per project or for all projects.
- **Project Detail Page**: shows a "CO₂ Rate Verification" badge (✅ verified / 🚩 flagged / ⚠️ under review) with the verification notes

## Security

| Concern                 | Mitigation                                                 |
| ----------------------- | ---------------------------------------------------------- |
| Private key exposure    | Freighter signs locally — keys never touch the app         |
| Fake donation records   | Backend deduplicates by tx hash; contract is ground truth  |
| Project wallet spoofing | Admin must register projects on-chain via Soroban          |
| Sybil donors            | On-chain stats cannot be faked — all linked to real wallet |
| Backend downtime        | Donations still work — backend is not on the critical path |
| Inflated CO₂ rates      | Automated verification against independent scientific data |
