import json, os, sys

secrets = json.load(sys.stdin)
secrets_list = os.environ.get('SECRETS_LIST', '').split()

for secret in secrets_list:
    old_val = os.environ.get(f'OLD_{secret}')
    if old_val:
        print(f'  Restoring {secret}...', file=sys.stderr)
        secrets[secret.lower() if secret != secret.upper() else secret] = old_val
    else:
        print(f'  WARNING: No old value found for {secret}', file=sys.stderr)

print(json.dumps(secrets, indent=2))
