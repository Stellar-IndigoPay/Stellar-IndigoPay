# Security Policy

## Reporting a Vulnerability

We take the security of Stellar-IndigoPay seriously. If you discover a security vulnerability, please report it to us responsibly.

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, please use one of the following methods:

- Send a private disclosure email to our security team.
- Use **GitHub Security Advisories** to privately report a vulnerability to the maintainers of this repository.

## Response Service Level Agreement (SLA)

We are committed to resolving security issues promptly. Our response SLA is as follows:

- **Acknowledgement**: We will acknowledge receipt of your vulnerability report within **48 hours**.
- **Patch/Resolution**: For critical vulnerabilities, we aim to provide a patch or mitigation within **30 days**.

## Out-of-Scope Issues

The following issues are currently considered out of scope for our security response:

- Issues or vulnerabilities that are strictly applicable to **testnet-only** environments.
- Rate limiting bypasses that do not demonstrate a tangible, real-world security impact.
- Volumetric or application-level Denial of Service (DoS) attacks.
- Social engineering or phishing attacks.

## Bug Bounty Scope

At this time, we do not have an active, paid bug bounty program. However, we deeply appreciate community contributions and will gladly provide public acknowledgment or credit to security researchers who responsibly disclose valid vulnerabilities.

## Trust Model

The Stellar-IndigoPay protocol operates on a dual-mode trust model for cross-chain attestations:

### Light Client Proof Verification (Trustless)
For chains configured with a validator set (`set_light_client_validators`), the attestation contract relies on an M-of-N multisignature scheme to finalize block hashes. Once finalized, anyone can submit an attestation accompanied by an EVM light client proof (Merkle-Patricia Trie receipt/transaction inclusion proof). 
The contract independently verifies this proof against the finalized block hash on-chain, effectively removing trust in any single relayer entity.

### Trusted Relayer (Fallback)
For chains without an active validator set, the contract falls back to a Trusted Relayer model. A designated admin-configured relayer address holds the sole authority to record attestations for these specific chains. If the relayer key is compromised, fraudulent attestations could be recorded on these chains until the relayer is cleared via `clear_relayer`.
