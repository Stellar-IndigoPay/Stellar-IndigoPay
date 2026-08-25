import json, os, sys

secrets = json.load(sys.stdin)
secrets_list = os.environ.get('SECRETS_LIST', '').split()

for secret in secrets_list:
    old_val = os.environ.get(f'OLD_{secret}')
    if old_val:
        print(f'  Restoring {secret}...', file=sys.stderr)

        # Special handling for webhook signing secret - restore multi-version structure
        if secret == 'WEBHOOK_SIGNING_SECRET':
            # Restore the previous current as current, and clear previous
            if 'webhook_signing' in secrets and isinstance(secrets['webhook_signing'], dict):
                old_previous = secrets['webhook_signing'].get('previous')
                old_key_id = secrets['webhook_signing'].get('keyId', 'v1')

                # Decrement version number
                if old_key_id.startswith('v'):
                    try:
                        version = int(old_key_id.split('-')[0][1:]) - 1
                        restored_key_id = f'v{max(1, version)}-{old_key_id.split("-")[1] if "-" in old_key_id else "2024-01-01"}'
                    except (IndexError, ValueError):
                        restored_key_id = 'v1-2024-01-01'
                else:
                    restored_key_id = 'v1-2024-01-01'

                secrets['webhook_signing'] = {
                    'current': old_val,
                    'previous': old_previous,
                    'next': None,
                    'keyId': restored_key_id
                }
                print(f'    Restored dual-version structure with keyId: {restored_key_id}', file=sys.stderr)
            else:
                # Fallback to simple structure
                secrets['webhook_signing_secret'] = old_val
        else:
            secrets[secret.lower() if secret != secret.upper() else secret] = old_val
    else:
        print(f'  WARNING: No old value found for {secret}', file=sys.stderr)

print(json.dumps(secrets, indent=2))
