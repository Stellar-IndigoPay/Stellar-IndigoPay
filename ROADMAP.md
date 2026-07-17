# 🗺 Stellar IndigoPay — Roadmap

---

## ✅ v1.0 — Foundation

- [x] Freighter wallet connection
- [x] Browse verified climate projects
- [x] Donate XLM to any project
- [x] On-chain donation tracking via Soroban
- [x] Donor leaderboard
- [x] Project update feed
- [x] Node.js backend API

---

## ✅ v1.1 — Developer Experience

- [x] Docker Compose one-command setup
- [x] GitHub Actions CI for all layers
- [x] Unit tests for backend services
- [x] Playwright e2e tests

---

## ✅ v1.2 — Verified Projects

- [x] Project verification submission form
- [x] Admin review and approval flow
- [x] Verified badge with on-chain proof
- [x] Project registration via Soroban contract

---

## ✅ v1.3 — Impact NFT Badges

- [x] Mint an impact NFT when donation threshold is reached
- [x] Badge tiers: Seedling 🌱, Tree 🌳, Forest 🌲, Earth Guardian 🌍
- [x] Display badges on donor profile
- [x] Share badge on social media

---

## ✅ v1.4 — Community Features

- [x] Donor comments on project pages
- [x] Project update notifications
- [x] Follow a project
- [x] Monthly impact digest email
- [x] Pause / resume projects

---

## ✅ v1.5 — Impact Dashboard

- [x] Total CO₂ offset tracker
- [x] Real-time donation stream (Socket.IO)
- [x] Project completion percentage
- [x] Global impact map
- [x] AI-generated project impact summaries

---

## ✅ v2.0 — Multi-Currency

- [x] USDC donations alongside XLM
- [x] On-chain price oracle for XLM/USDC conversion
- [x] Show donation value in XLM-equivalent

---

## ✅ v2.1 — DAO Governance & Escrow

- [x] Community vote on which projects get verified
- [x] Voting power proportional to donor badge tier (≥ Seedling)
- [x] On-chain proposal and voting contract
- [x] Configurable voting windows
- [x] Admin veto for incident response
- [x] Escrow contract for milestone-based project payouts
- [x] Two-step admin transfer
- [x] 48-hour upgrade timelock
- [x] Contract-level pause/unpause

---

## 🚧 v2.2 — Cross-Chain & Mobile-First (Planned)

> **Ideas for the next release — contributions welcome!**

- [x] Cross-chain donation attestations — landed in #125. New
  `attestation-contract` Soroban contract, off-chain backend API at
  `/api/attestations`, frontend `/verify` page + bridge page upgrade.
- [ ] Deeper Stellar DEX integration for auto conversion
- [ ] Push notification overhaul
- [ ] In-app wallet (non-custodial key management)
- [ ] Recurring donation scheduler on-chain
- [ ] Project verification oracle network

---

## 💡 How to propose a new item

Open a [GitHub Discussion](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/discussions) with the `🚀 roadmap` label. We triage every month.
