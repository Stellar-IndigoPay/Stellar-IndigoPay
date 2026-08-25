#!/usr/bin/env python3
"""
Cleanup expired webhook signing keys.

This script removes previous keys that have exceeded the grace period
after a rotation. It should be called after the grace period (7 days)
to clean up old secrets from AWS Secrets Manager.
"""

import json
import os
import sys
from datetime import datetime, timedelta

def is_key_expired(key_id, grace_days=7):
    """Check if a key ID has expired based on the grace period."""
    if not key_id or not key_id.startswith('v'):
        return False

    try:
        # Parse key ID format: v{version}-{date}
        parts = key_id.split('-')
        if len(parts) < 2:
            return False

        date_str = parts[1]
        key_date = datetime.strptime(date_str, '%Y-%m-%d')
        expiry_date = key_date + timedelta(days=grace_days)
        return datetime.now() > expiry_date
    except (ValueError, IndexError):
        return False

def cleanup_expired_keys(secrets):
    """Remove expired previous keys from the webhook signing structure."""
    if 'webhook_signing' not in secrets or not isinstance(secrets['webhook_signing'], dict):
        print("  No webhook_signing structure found, skipping cleanup", file=sys.stderr)
        return secrets

    webhook = secrets['webhook_signing']
    previous = webhook.get('previous')

    if previous and not is_key_expired(webhook.get('keyId', 'v1')):
        print(f"  Previous key still within grace period, keeping it", file=sys.stderr)
        return secrets

    if previous:
        print(f"  Removing expired previous key", file=sys.stderr)
        webhook['previous'] = None

    return secrets

def main():
    # Read current secrets from stdin
    secrets = json.load(sys.stdin)

    print("  Checking for expired webhook signing keys...", file=sys.stderr)
    secrets = cleanup_expired_keys(secrets)

    # Output updated secrets
    print(json.dumps(secrets, indent=2))

if __name__ == '__main__':
    main()