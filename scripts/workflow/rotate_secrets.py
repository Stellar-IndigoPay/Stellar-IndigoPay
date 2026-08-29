#!/usr/bin/env python3
"""
scripts/workflow/rotate_secrets.py

Dual-version secret rotation (Workstream 3 of #1100).

Implements Phase 1 of the rotation protocol — "generation & dual-version
staging" — without touching any live secret manager. The script:

  1. Reads the current secret values (from a JSON file or the secret manager
     via `--provider aws`).
  2. For each secret in `--secrets`:
       a. Demotes the current value to `PREVIOUS`.
       b. Generates a cryptographically random replacement.
       c. Stages the replacement as `NEXT`.
  3. Writes the staged versions (current/previous/next raw values) to the
     PROTECTED output file given by `--out`, created with mode 0o600. Raw secret
     values are NEVER printed to stdout — console output is limited to status
     lines and SHA-256 fingerprints for the audit trail.

Nothing is written to the external secret manager here; `update_secrets.py`
applies the staged values and `restore_secrets.py` can roll back to the
`PREVIOUS` value on a failed health check. Consumers (signingSecretProvider.js,
middleware/auth.js) accept current + previous + next simultaneously, so the
rotation window has zero authentication failures.

Usage examples:
  # Rotate JWT + webhook signing secrets using values from a JSON payload.
  python scripts/workflow/rotate_secrets.py \
      --secrets JWT_SECRET,WEBHOOK_SIGNING_SECRET \
      --from-json /tmp/current-secrets.json \
      --out /tmp/rotated.json

  # Against AWS Secrets Manager:
  python scripts/workflow/rotate_secrets.py \
      --provider aws --secrets-manager-path stellar-indigopay/prod \
      --secrets JWT_SECRET \
      --out /tmp/rotated.json
"""

import argparse
import hashlib
import json
import os
import secrets
import string


def _random_value(length: int = 48) -> str:
    """Cryptographically random alphanumeric string (safe for URLs, env, etc.)."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_current(provider: str, from_json: str, secrets_manager_path: str) -> dict:
    if provider == "json":
        with open(from_json, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else data.get("secrets", {})

    if provider == "aws":
        import boto3  # require boto3 only when the provider is aws

        client = boto3.client("secretsmanager")
        resp = client.get_secret_value(SecretId=secrets_manager_path)
        return json.loads(resp["SecretString"])

    raise ValueError(f"Unknown provider: {provider}. Use 'json' or 'aws'.")


def build_staged(secrets_list, current_values):
    """
    Build the dual-version staged payload per the rotation protocol:

      {secret: {
          "current": <existing current value>,
          "previous": <demoted current — remains valid for verification>,
          "next":     <newly generated value — deployed, verified, then promoted>,
          "current_hash": <sha256 of current>,
          "next_hash":    <sha256 of next>,
      }}
    """
    staged = {}
    for name in secrets_list:
        current = current_values.get(name)
        if not current:
            raise FileNotFoundError(
                f"Current value for '{name}' not present in source payload. "
                "The dual-version protocol requires the current value to rotate it."
            )
        next_value = "ip_secret_" + _random_value(48)
        staged[name] = {
            "current": current,
            "previous": current,  # demote old current; still verifiable
            "next": next_value,
            "current_hash": sha256_hex(current),
            "next_hash": sha256_hex(next_value),
        }
    return staged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secrets", required=True,
                        help="Comma-separated list of secret names to rotate")
    parser.add_argument("--provider", default="json",
                        choices=["json", "aws"],
                        help="Source of the current secret values")
    parser.add_argument("--from-json", default="",
                        help="Path to a JSON file with current secret values")
    parser.add_argument("--secrets-manager-path", default="",
                        help="AWS Secrets Manager secret id (with --provider aws)")
    # --out is required: the staged payload contains raw CURRENT/PREVIOUS/NEXT
    # secret values and must never be dumped to stdout (logs/CI would leak it).
    parser.add_argument("--out", required=True,
                        help="Protected output path for the staged JSON payload (written with mode 0o600)")
    args = parser.parse_args()

    secrets_list = [s.strip() for s in args.secrets.split(",") if s.strip()]
    if not secrets_list:
        raise SystemExit("No secrets provided.")

    current_values = load_current(
        args.provider, args.from_json, args.secrets_manager_path
    )
    staged = build_staged(secrets_list, current_values)

    payload = {
        "protocol": "dual-version",
        "step": "staged-next",
        "secrets": staged,
    }
    rendered = json.dumps(payload, indent=2) + "\n"

    # Write the secret-bearing payload with restrictive permissions (0o600) so
    # it is only readable by the owning user, never world/group readable.
    _write_protected(args.out, rendered)

    # Console output is limited to NON-SENSITIVE status lines + fingerprints
    # (SHA-256 hashes) for the audit trail — never raw secret values.
    print(f"[rotate_secrets] staged {len(secrets_list)} secret(s) -> {args.out}")
    for name in secrets_list:
        entry = staged.get(name, {})
        print(
            f"  {name}: current={entry.get('current_hash', '?')} "
            f"next={entry.get('next_hash', '?')}"
        )


def _write_protected(path: str, content: str) -> None:
    """Write `content` to `path` with mode 0o600 (owner read/write only)."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    fh = None
    try:
        os.fchmod(fd, 0o600)
        fh = os.fdopen(fd, "w", encoding="utf-8")
        fh.write(content)
        fh.flush()
    finally:
        if fh is not None:
            fh.close()
        else:
            os.close(fd)


if __name__ == "__main__":
    main()