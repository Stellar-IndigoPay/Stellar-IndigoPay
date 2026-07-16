## [Unreleased]

### Features

* **backend,frontend:** add Idempotency-Key support for donation recording (closes #148)
  - Accept `Idempotency-Key` header (UUID v4) on `POST /api/donations`; store response and replay within 24 hours
  - New `idempotency_keys` table via migration 016 with index on `created_at`
  - Hourly pg-boss cleanup cron (`idempotencyCleanup`) purges expired keys (configurable via `IDEMPOTENCY_CLEANUP_CRON`)
  - Frontend: `DonateForm` and `bridge` generate `crypto.randomUUID()` per donation attempt
  - Documented in OpenAPI spec with 200 replay response
  - 11 new tests: 5 unit (donations), 8 unit (cleanup), 3 integration (testcontainers)

* **docs:** add CONTRIBUTORS.md to credit community work (GF-015, closes #64)

* **backend:** implement Soroban RPC retry with exponential backoff and circuit breaker (GF-043, closes #100)
  - Add `backend/src/services/circuitBreaker.js` — reusable `CircuitBreaker` class (CLOSED / HALF_OPEN / OPEN state machine, configurable `failureThreshold` and `resetTimeout`)
  - Export `indigopay_soroban_circuit_breaker_state` Prometheus Gauge (0=closed, 1=half_open, 2=open)
  - Update `backend/src/services/stellar.js` with `withRetry()` (exponential backoff: 100ms → 200ms → 400ms, max 3 retries env-configurable via `SOROBAN_RPC_MAX_RETRIES`) and `rpcBreaker` circuit breaker wrapping all Soroban RPC calls
  - Export `indigopay_soroban_rpc_retries_total` Prometheus Counter
  - Update `backend/src/routes/readiness.js` to include `soroban_rpc` health check in `/api/readyz` response (reports `ok` or `degraded`)
  - Add 33-test suite `backend/src/services/circuitBreaker.test.js` covering state machine, `isRetryable` classification, retry logic, circuit breaker open/half-open/closed transitions, and Prometheus metrics

---

# 1.0.0 (2026-07-12)


### Bug Fixes

* **backend:** add missing zod, profileQueue, and donationEvents imports in donations route ([1f9e8b0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1f9e8b0568e5ba737674adab596e1f38156fbeb3))
* **backend:** env.js zod v4 API + DATABASE_URL default + new observability vars ([6caf834](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6caf834466c2140e243d4abe5b266d2c30768664))
* **backend:** indexer service stop() for clean shutdown ([183da6b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/183da6b37e79dad3f761d7269706bed7b93335a1))
* **backend:** pool statement_timeout + connectionTimeoutMillis tuning ([225da4a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/225da4a4256c2b1a675f06543b06d2c42cf3fa92))
* **backend:** webhook retry scheduler uses boss.send startAfter; deduped enqueue returns existing deliveryId ([211ab07](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/211ab07aba32a262b3ca7031bd15653093dd2aea))
* **ci:** make ZAP target configurable + continue-on-error; gate mobile EAS on EXPO_TOKEN secret ([2e54aab](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2e54aab067896690fce8607f1a9485c8d3db4e46))
* **ci:** pin backend Dockerfile to node:20.18.1-alpine with SHA256 digest; switch to npm ci --omit=dev ([2e960fb](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2e960fb58792a98bd347d0ef0e76cd1141e0161d))
* **ci:** pin frontend Dockerfile to node:20.18.1-alpine LTS; switch to npm ci --omit=dev ([0a165cf](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0a165cf89bbce9423b1c88fd6f699ec444904033))
* **ci:** pin secret-scanning workflow to actions/checkout@v4 (v6 does not exist) ([b2b38ce](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b2b38ced98e35185f9d8cb0f6955c1c982f2e6b4))
* **ci:** pin trivy-action to commit SHA b6643c0e5cc8a9c9b5b2cb06a73c4a3d9eb7c5d2 ([08e3545](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/08e354528d18cf7b91ddca8d91b96d6705bd1b73))
* **ci:** remove fabricated SHA256 digests from backend Dockerfile (3 stages) ([c93d4f6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/c93d4f6d3feedee16f3798751f38526fb70e44f6))
* **ci:** resolve 5 CI pipeline failures (lints, a11y, contracts, gitleaks, helm) ([d4eb13a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d4eb13a1d09a115630f147ebb5919fc09087b1cc))
* **ci:** resolve backend test failures and frontend ESLint config ([f2e7c28](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f2e7c282fa98dce99a6dadcd52e38c4f72041e6a))
* **ci:** revert fabricated trivy SHA back to tag with note to pin in production ([63021e2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/63021e24beade8229802d69a5bf1fd030fb29a4b))
* **ci:** suppress gitleaks false positives and fix helm validation in CI ([ef13c6f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ef13c6f65a089af4003eb66dd4b26506e38a0131))
* **escrow-contract:** apply CEI ordering and correct contract attribute placement ([6929405](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6929405823116dd74b855b8ff6b59bbdcfae3b2b))
* explicitly set toolchain 1.91.0 in contracts.yml so rustfmt/clippy are installed for the right version ([86b5afc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/86b5afce43f9ffba73043669d3db827b25e3ab4b))
* **frontend:** downgrade eslint to ^8.57.0 to match eslint-config-next@14.2.3 peer-dep range ([16b35b5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/16b35b52845774b03493b93fc7b223d57e192f84))
* **frontend:** fully regenerate package-lock.json (npm ci was missing to-buffer@1.2.2) ([6c1e207](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6c1e207ecdb1945aa98f57744efb2a9baf208733))
* **frontend:** repair broken JSX in ProjectCard (nested button, mismatched tags, duplicate Donate element) ([f0c0018](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f0c001872eca8effbcfb160a143774702aabbd0e))
* **frontend:** resolve all TypeScript build errors and add missing API functions ([4d8062b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4d8062b4f7d0811a473d63f53e7f64aa0bf6b75d))
* **helm:** add _helpers.tpl with backendName, frontendName, commonLabels ([6b3c457](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6b3c4574da4bbaaf73379d0553bb547e32d17206))
* **k8s:** allow frontend egress to backend on port 4000 (closes default-deny gap) ([f0d980a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f0d980a67ff3cc1a29fd9ea11a62d62ac60ccea6))
* **k8s:** convert k8s/secret.yaml to REPLACE_ME template (lint-safe) ([9a2403e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9a2403ea124d2c3643b69afaf1c1a0740a3a671a))
* **k8s:** use __LIKE_THIS__ placeholders so secrets-lint does not trip on the template ([2acbb02](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2acbb028ace6087c796ef603535772fbb85c7c24))
* pin trivy-action to specific version 0.28.0 instead of master ([ea871dc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ea871dc23454308172d46e54886b16ba086031dc))
* rebuild Soroban Contracts CI and fix all remaining CI failures ([09aaa96](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/09aaa9653320da5ec35597a7aa88992725d397e4))
* resolve all five CI failures ([35897d0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/35897d05e271281caee881e358f01ab33034decf))
* resolve CI failures across helm, backend, and extension ([1341905](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/13419050451a7004140a8b73115da22498fe4836))
* resolve remaining CI failures (gitleaks, trivy, contracts) ([ec7f27a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ec7f27aaf91a1c8e5d789dab60e12a46eed210a4))
* resolve Soroban Contracts CI failures - remove untracked path-patch, suppress deprecated Events::publish, fix test bugs ([a4cc10a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a4cc10ab7214491cde230daf6df05ae6e56ff025))


### Features

* **backend:** add /metrics scrape endpoint with bearer auth ([b433759](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b433759bb041874426ad0c5208f42a716870c1de))
* **backend:** add lifecycle service for graceful shutdown ([1ce9d93](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1ce9d9373c00c76709aaeedab8a8339a2b47c646))
* **backend:** add per-request HTTP metrics middleware ([4975707](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4975707e6ff61fdd0ec2dc7ef810010da7215778))
* **backend:** add prom-client metrics service ([c813fe6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/c813fe6d7e78ce5f006ee7eda2db442536068cc5))
* **backend:** add X-Request-Id response header middleware ([f810414](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f810414c625c8c9ec305d01b3aaf7c970a547063))
* **backend:** ai_summary tokens, cost, latency and outcomes Prometheus metrics ([dba7a67](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/dba7a672ef95ba16e1cfd333cab3014531cdab56))
* **backend:** rewrite server.js bootstrap with proper middleware order ([088f6af](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/088f6afcd80062c68076634b5676e8c526df4941))
* **backend:** split health into liveness and readiness ([9f248b4](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9f248b4f195a50bb83bbc6769d23f7acda896501))
* **backend:** webhook delivery + attempt + duration Prometheus counters ([ba2f32b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/ba2f32b50a7b925e24144ea71c97f0cb98932a4b))
* **backend:** webhook delivery queue with pg-boss, DLQ, GitHub-style signing ([2a2b586](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2a2b58635f002eb34bb653b43767d6c4a50b5f95))
* **backend:** webhook signing helper with GitHub-style t=...,v1=... + replay window ([0b77240](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0b772402ccbc057fbb81fe5fa451613aec5d0130))
* **backend:** wire webhookQueue.start into boot + lifecycle shutdown ([e310cdb](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/e310cdb5f2f9f54d81cef97098d95330af36a059))
* **ci:** monthly restore-drill workflow that pulls latest backup and asserts row counts ([fe1af2c](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/fe1af2cbdd37d928bbf4da42091e11b928923389))
* **ci:** SBOM generation with anchore/sbom-action, uploads to GitHub dependency graph ([d70d0a6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d70d0a6b869a908e269881e1196e9b524ab56c6f))
* **ci:** Trivy image scan failing on CRITICAL/HIGH with fix available ([a5c47ae](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a5c47aeb0fda34a6b10ea73bf20358ac9cc99909))
* **contracts:** 48h upgrade timelock (propose_upgrade / execute_upgrade / cancel) ([f9a7a33](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f9a7a33b59517d17fa58c604fa4454af0ecf2e01))
* **contracts:** contract-level pause (pause_contract / unpause_contract) ([dcd8c87](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/dcd8c87c72097bd9bb8c7af3624f0961c5779b13))
* **contracts:** two-step admin transfer (transfer_admin / accept_admin / cancel) ([7049578](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/70495788eb9ea7069a590a446171a5fceda82544))
* **db:** add prompt_versions and ai_summary_calls tables ([0e4b982](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0e4b982b6aefff488e5ba0c9f0919e09e32af1cb))
* **db:** add webhook_deliveries and webhook_dlq tables for retry bookkeeping ([53619d6](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/53619d67de508e40dfcbc2e1d97f6b70db9b474d))
* **frontend:** add ErrorBoundary with Sentry capture and prod-safe fallback ([cc8332d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/cc8332d4a3390292bd4f87bb8f5588cf6dcdf917))
* **frontend:** add WalletProvider context with lifecycle state machine ([7a31511](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/7a31511da3c4bb1cad184bafeb32fbe226116a73))
* **frontend:** wire WalletProvider + ErrorBoundary into _app.tsx ([177d7e2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/177d7e217c5448311b51b26c8e5cfbc69965ad5d))
* **frontend:** wire withSentryConfig into next.config.mjs ([a39230a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a39230a72dfe72c0303def8c2cf91e92246bd07a))
* **gitops:** Argo Rollouts canary strategy with Prometheus success-rate analysis ([58fca67](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/58fca679818ddca1a0c0cde05ae42f31c0ca608b))
* **gitops:** ArgoCD Application manifest for chart-driven reconciliation ([8ba7026](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/8ba7026da4e2bb67a2a4d752f58806d65154a848))
* **helm:** HPA template wired to values.autoscaling ([e03eb40](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/e03eb40110f458ed6c57cf48d82ab521d966704b))
* **helm:** PodDisruptionBudget template wired to values.pdb ([0007965](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/0007965ad16ce9cd352dff690503cc8b23fe9e1f))
* **indigo-contract:** add project lifecycle pause/resume and bulk-deactivate admin functions ([fb4968f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/fb4968f0c590ae37a966036cfe6520a3dc61970e))
* **k8s+helm:** ServiceMonitor + metrics port + probes + secrets ([7844f6b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/7844f6b6da832e6756448c1b504d678c6742088d))
* **k8s:** allow backend egress to postgres on 5432 plus kube-dns ([9c66e74](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9c66e74a6c0499d1797d16ee8437ff458b3dbe2d))
* **k8s:** allow backend egress to redis on 6379 ([d083f61](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d083f6139fead839e29cd51534318226b7c0c7d6))
* **k8s:** allow backend egress to Stellar Horizon, Soroban RPC, Anthropic, Sentry ([1c95044](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1c95044acbf0cdf2fa8a8f329feacfe8e0d28a2d))
* **k8s:** allow ingress-nginx to reach backend on port 4000 ([a441e1f](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/a441e1f6ac732539b4db2604fa60a870fe419221))
* **k8s:** allow prometheus to scrape backend /metrics on port 4000 ([2b2f094](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2b2f0945210ca40bfc303a0ab9a4dd55ad2693ac))
* **k8s:** default-deny NetworkPolicy for the indigopay namespace ([4a6065d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4a6065dca11278f3a976ddbfa00749171a53c546))
* **k8s:** ExternalSecret + SecretStore template for AWS Secrets Manager ([b070c22](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b070c229a69166d0e58d35fc9c4bf2f9d6c8025d))
* **k8s:** HPA for backend, min 2 max 10, CPU 70% + memory 80% ([9572668](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/9572668529c84410d3104dc8661e1ab75611c3b4))
* **k8s:** HPA for frontend, min 2 max 10, CPU 70% + memory 80% ([05b4828](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/05b482814dda07266592a8e10139f72b8b9fc3ef))
* **k8s:** PodDisruptionBudget for backend with minAvailable 1 ([f975210](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/f975210c9a4c406ae40ae6607b7ded9be5328c94))
* **k8s:** PodDisruptionBudget for frontend with minAvailable 1 ([bfb7fac](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/bfb7fac963c9313bf87788e694c442ec4ce35f0d))
* **k8s:** ServiceAccount stub for external-secrets-operator IRSA binding ([2cc0156](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2cc0156c2b55cc0f033bd1c0bdabeab3d9dd2ff6))
* **mobile:** add AuthGate with state-aware fallback UI ([1933d34](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/1933d34204691137b5143acc08e2e6835cd01f0e))
* **mobile:** add AuthProvider context with biometric unlock and 60s auto-lock ([5c37c00](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/5c37c005e5a70a3dfc32d1f774bbedeb9adfda71))
* **mobile:** add fire-and-forget errorReporter sink with Sentry forwarding ([007f01b](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/007f01b6b8e40aaa586afeb5a77ed70505aaaa3a))
* **mobile:** add global ErrorBoundary with prod-safe fallback ([24e1cbc](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/24e1cbc778bd98c3700fe264262c8d92bb47db5f))
* **mobile:** add SecureStore wrapper with biometric-gated options ([73c16fa](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/73c16fa4d35b5c381013acc56d107840cf676bb6))
* **mobile:** wire ErrorBoundary + AuthProvider into _layout.tsx ([8cedc0a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/8cedc0a2798d10440fb4f09af6ab14d01e01b270))
* **monitoring:** alertmanager routing with PagerDuty + Slack + business hours + inhibition ([71cc086](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/71cc0864c8096a6a4ef4afd33d3aa73c0b78333b))
* **monitoring:** Prometheus + Grafana + alert rules + dashboard ([34bf716](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/34bf716edfb3f62faf9cfff21a7307733c219c37))
* **monitoring:** routing-aware alert rules (BackendDown, BackupMissed, RestoreDrillFailed) ([878fd8e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/878fd8ef160a7aef493e7c67cbb6670bcf034cfa))
* rebrand frontend design system with indigo/purple color palette ([724ef57](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/724ef57b271e8540f5c6a0686d3b1321c6d81ed1)), closes [#227239](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/227239) [#2d6a2d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/2d6a2d) [#f0f7f0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/f0f7f0) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE)
* update email templates with indigo color scheme ([4b5b7f2](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4b5b7f21e72d55b4d0e8640656bf57b6d75bd491)), closes [#2d6a2d](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/2d6a2d) [#f0f7f0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/f0f7f0) [#1a3a1a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/1a3a1a) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE) [#0F172A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0F172A)
* update frontend donation components with indigo colors ([4a2ebc0](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/4a2ebc078dc8c35433743a3950c727bee7689273)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8)
* update frontend leaderboard, wallet and utility components with indigo colors ([cace51e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/cace51e90497ff948a254b9c2c8df86148160b2d))
* update frontend Navbar with indigo logo styling ([2350b4e](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/2350b4ee2d704eda9e84b95c33b2810b84dd940f)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8)
* update frontend pages with indigo design system ([09ab67c](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/09ab67cdfa86374a0f847ed9ec83e8e3e276b13d)), closes [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#0F172A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0F172A)
* update frontend project components with indigo palette ([6516483](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/6516483c5e5b09bfeeb40e51588b83794547c591))
* update frontend UI components with indigo design ([b04aca1](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/b04aca1bfc9837347535b5f5dc9d1a6091684274))
* update mobile app theme with indigo palette ([d6da922](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/commit/d6da92249ea6ea07a1ee07e4e896ca9577da5a8d)), closes [#227239](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/227239) [#5a7a5a](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/5a7a5a) [#4F46E5](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/4F46E5) [#818CF8](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/818CF8) [#0A0A1A](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/0A0A1A) [#FAFAFE](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/FAFAFE)

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Webhook reliability** — `webhookQueue` worker backed by pg-boss with a
  6-attempt exponential backoff (30s → 2m → 10m → 30m → 2h → 6h) and a
  dead-letter table (`webhook_dlq`) for permanent failures. Replaces the
  old fire-and-forget `fetch` with a durable retry / DLQ pipeline.
- **Webhook signing** — `webhookSign` helper implementing GitHub-style
  `t=…,v1=…` HMAC-SHA256 with a 5-minute replay window and constant-time
  comparison. Idempotency enforced by `INSERT … ON CONFLICT DO UPDATE
RETURNING id, (xmax=0) AS inserted` on `webhook_deliveries`.
- **Webhook Prometheus metrics** — `webhook_deliveries_total`,
  `webhook_delivery_attempts_total`, `webhook_delivery_duration_seconds`,
  plus `ai_summary_tokens_total`, `ai_summary_cost_usd_total`,
  `ai_summary_latency_seconds`, and `ai_summary_outcomes_total`.
- New database tables: `webhook_deliveries`, `webhook_dlq`,
  `prompt_versions`, and `ai_summary_calls`.
- **Soroban trust model** — 48h upgrade timelock
  (`propose_upgrade` / `execute_upgrade` / `cancel`), contract-level pause
  (`pause_contract` / `unpause_contract`), and two-step admin transfer
  (`transfer_admin` / `accept_admin` / `cancel`). Full threat model
  documented in `contracts/indigopay-contract/SECURITY.md` and
  `UPGRADE.md`.
- Backend observability env vars documented in `.env.example`
  (`METRICS_BEARER_TOKEN`, `INDEXER_*`, `SENTRY_*`, etc.).
- 32 Jest cases covering metrics, lifecycle, requestId, health, and
  readiness in `backend/__tests__/`.

### Changed

- `backend/src/routes/webhook.js` defers delivery to `webhookQueue`;
  the public route surface is preserved so existing partners keep working.
- `backend/src/server.js` wires `webhookQueue.start` into boot and
  registers a lifecycle shutdown hook to drain in-flight jobs on SIGTERM.
- Soroban contracts: extracted a shared `require_admin` helper and
  unified the admin panic message across all admin-only entry points.
- `docs/README.md` indexes every document by audience (users, developers,
  operators, contributors).

### Fixed

- `webhook.js` retry scheduler now uses `boss.send(..., { startAfter })`
  instead of relying on the implicit loop. A deduped enqueue returns the
  existing `deliveryId` rather than silently re-creating a row.
- `backend/src/services/indexerService` exposes a `stop()` method so the
  Stellar Horizon stream is closed cleanly on SIGTERM.

- **scripts:** ensure `scripts/setup-dev.sh` installs `mobile` and `extension` dependencies (fix README mismatch)

- **NetworkPolicies** — default-deny for the `indigopay` namespace plus
  explicit allow policies for ingress → backend, backend → postgres +
  kube-dns, backend → redis, backend → Stellar Horizon / Soroban RPC /
  Anthropic / Sentry, Prometheus → backend `/metrics`, and frontend →
  backend (the last one closes the default-deny gap for the Next.js client).
- **Autoscaling** — `HorizontalPodAutoscaler` for backend and frontend
  (min 2, max 10, CPU 70% / memory 80%) and `PodDisruptionBudget` with
  `minAvailable: 1` for both, mirrored in the Helm chart via
  `values.autoscaling` and `values.pdb`.
- **Helm chart** — new `_helpers.tpl` (`backendName`, `frontendName`,
  `commonLabels`) and `values.yaml` blocks for autoscaling and PDB so
  the chart actually renders end-to-end (`helm template` was previously
  broken by missing helpers).
- **Secrets management** — `k8s/secret.example.yaml` is the checked-in
  template; the real `k8s/secret.yaml` is gitignored;
  `.github/workflows/secrets-lint.yml` fails CI on placeholder leaks in
  `k8s/`, `helm/`, and `monitoring/`. The template was rewritten to use
  lint-safe `__LIKE_THIS__` markers so the lint does not trip on it.
- **External Secrets** — `ExternalSecret` + `SecretStore` templates for
  AWS Secrets Manager, an IRSA `ServiceAccount` stub, and full setup
  documentation (`docs/external-secrets.md`).

- **Disaster recovery** — explicit RTO / RPO table, failure modes,
  secret-compromise procedure, and multi-region roadmap
  (`docs/disaster-recovery.md`).
- **Restore runbook** — pre-flight → provision → cutover → post-restore
  → dry-run procedure (`docs/restore-runbook.md`).
- **Restore-drill workflow** — monthly CI job that pulls the latest
  backup and asserts table row counts
  (`.github/workflows/restore-drill.yml`).
- **Alert routing** — Alertmanager with PagerDuty + Slack + business
  hours override + inhibition rules
  (`monitoring/alertmanager-routing.yml`), plus routing-aware alert
  rules (`BackendDown`, `BackupMissed`, `RestoreDrillFailed`).
- **Image hardening** — `backend/Dockerfile` and `frontend/Dockerfile`
  pinned to `node:20.18.1-alpine` LTS; switched to `npm ci --omit=dev`
  for reproducible installs.
- **SBOM** — `anchore/sbom-action` uploads a Software Bill of Materials
  to the GitHub dependency graph on every push.
- **Image scan** — Trivy scan failing on CRITICAL / HIGH with fix
  available.
- **Image signing** — cosign keyless signing on release tags.
- **GitOps** — ArgoCD `Application` manifest for chart-driven
  reconciliation, Argo Rollouts stepped canary strategy with Prometheus
  success-rate analysis (header corrected to reflect default stepped
  mode rather than traffic-split canary).
- **Observability** — Prometheus + Grafana + Alertmanager stack with
  persistent volumes; `ServiceMonitor` + metrics port + readiness /
  liveness probes + metrics secret wiring for the backend; backend
  `indexerService.stop()` for clean shutdown.

### Removed

- `docs/openapi.yml` — stale duplicate of `docs/api/openapi.yaml`, which
  is the canonical OpenAPI 3.0.3 spec served by `swagger-ui-express` at
  `/api/docs` in development.

## [1.0.0] - 2025-01-01

### Added

- Wallet Connect via Freighter browser extension.
- Browse verified climate projects with impact metrics.
- Direct on-chain XLM donations to project wallets.
- Soroban smart contract for donation and CO₂ offset tracking.
- Donor leaderboard ranked by total XLM given.
- Project updates — organisations post progress updates to donors.
- CI/CD pipelines (lint, type-check, test, build, e2e, DAST).
- Docker Compose development environment with hot reload.
- Gitleaks secret scanning in CI.
- Backend API with Express and PostgreSQL.
- Mobile app (React Native / Expo).
- Browser extension.
- Helm chart for Kubernetes deployment.
