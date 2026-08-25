import json, os, sys
from datetime import datetime, timedelta

secrets = json.load(sys.stdin)
secrets_list = os.environ.get('SECRETS_LIST', '').split()

for secret in secrets_list:
    new_val = os.environ.get(f'NEW_{secret}')
    if new_val:
        print(f'  Rotating {secret}...', file=sys.stderr)

        # Special handling for webhook signing secret - dual-version support
        if secret == 'WEBHOOK_SIGNING_SECRET':
            old_val = secrets.get('webhook_signing_secret')
            current_version = 1

            # Extract current version if exists
            if 'webhook_signing' in secrets and isinstance(secrets['webhook_signing'], dict):
                old_val = secrets['webhook_signing'].get('current')
                # Parse version from keyId
                key_id = secrets['webhook_signing'].get('keyId', 'v1')
                if key_id.startswith('v'):
                    try:
                        current_version = int(key_id.split('-')[0][1:]) + 1
                    except (IndexError, ValueError):
                        current_version = 1

            # Create multi-version structure
            today = datetime.now().strftime('%Y-%m-%d')
            new_key_id = f'v{current_version}-{today}'

            secrets['webhook_signing'] = {
                'current': new_val,
                'previous': old_val,
                'next': None,
                'keyId': new_key_id
            }
            print(f'    Created dual-version structure with keyId: {new_key_id}', file=sys.stderr)
        else:
            secrets[secret.lower() if secret != secret.upper() else secret] = new_val
    else:
        print(f'  WARNING: No new value found for {secret}', file=sys.stderr)

print(json.dumps(secrets, indent=2))
