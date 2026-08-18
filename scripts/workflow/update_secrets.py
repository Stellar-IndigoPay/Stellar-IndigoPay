import json, os, sys

secrets = json.load(sys.stdin)
secrets_list = os.environ.get('SECRETS_LIST', '').split()

for secret in secrets_list:
    new_val = os.environ.get(f'NEW_{secret}')
    if new_val:
        print(f'  Rotating {secret}...', file=sys.stderr)
        secrets[secret.lower() if secret != secret.upper() else secret] = new_val
    else:
        print(f'  WARNING: No new value found for {secret}', file=sys.stderr)

print(json.dumps(secrets, indent=2))
