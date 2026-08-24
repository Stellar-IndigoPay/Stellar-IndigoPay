"""Build the audit log payload for secret rotation and POST it to the admin API."""
import json, os, sys, urllib.request, urllib.error
import yaml
from datetime import datetime

api_base = os.environ['API_BASE_URL']
admin_key = os.environ['ADMIN_API_KEY_VAR']
github_run_id = os.environ['GITHUB_RUN_ID']
github_event_name = os.environ['GITHUB_EVENT_NAME']
secrets_json_str = os.environ['SECRETS_JSON']
health_passed = os.environ.get('HEALTH_PASSED') or None
rollback_needed = os.environ.get('ROLLBACK_NEEDED') or False
overall_status = ('rolled_back' if rollback_needed == 'true'
                  else 'failed' if health_passed == 'false'
                  else 'completed')

# Load inventory
try:
    with open('secrets/inventory.yaml', 'r') as f:
        inventory_data = yaml.safe_load(f)
except Exception as e:
    print(f"::warning::Failed to load inventory: {e}")
    inventory_data = {'secrets': []}

payload = {
    'workflowRunId': github_run_id,
    'triggeredBy': github_event_name,
    'secretsRotated': json.loads(secrets_json_str),
    'overallStatus': overall_status,
    'healthCheckPassed': health_passed,
    'rollbackTriggered': rollback_needed == 'true',
    'rollbackReason': ('Health check failed after rotation — auto-rollback triggered'
                       if rollback_needed == 'true' else None),
    'metadata': {
        'githubRunId': os.environ['GITHUB_RUN_ID'],
        'githubRunNumber': os.environ['GITHUB_RUN_NUMBER'],
        'githubActor': os.environ['GITHUB_ACTOR'],
        'githubRef': os.environ['GITHUB_REF'],
        'workflowUrl': f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{github_run_id}",
        'esoForceSyncTriggeredAt': os.environ.get('ESO_FORCE_SYNC_AT'),
        'rollingRestartStartedAt': os.environ.get('ROLLING_RESTART_STARTED_AT'),
        'rollingRestartCompletedAt': os.environ.get('ROLLING_RESTART_COMPLETED_AT'),
    },
}

url = f"{api_base}/api/admin/secret-rotations"
req = urllib.request.Request(url, method='POST')
req.add_header('Content-Type', 'application/json')
req.add_header('X-Admin-Key', admin_key)

try:
    resp = urllib.request.urlopen(req, data=json.dumps(payload).encode())
    if resp.status == 201:
        body = json.loads(resp.read())
        rotation_id = body.get('data', {}).get('id', 'unknown')
        print(f'rotation_id={rotation_id}')
        print(f'✅ Rotation audit log recorded successfully')
    else:
        print(f'::warning::Failed to record rotation audit log (HTTP {resp.status})')
except urllib.error.HTTPError as e:
    print(f'::warning::Failed to record rotation audit log (HTTP {e.code})')
    print(e.read().decode())

# Update inventory and check overdue
if overall_status == 'completed':
    now_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    rotated_set = set(json.loads(secrets_json_str))
    
    overdue = []
    now_ts = datetime.utcnow().timestamp()
    
    for s in inventory_data.get('secrets', []):
        if s['name'] in rotated_set:
            s['last_rotation'] = now_str
            
        # Check if overdue
        rotation_period = s.get('rotation_period')
        last_rotation = s.get('last_rotation')
        if rotation_period and last_rotation and s['name'] not in rotated_set:
            if rotation_period.endswith('d'):
                days = int(rotation_period[:-1])
                try:
                    lr_date = datetime.strptime(last_rotation, "%Y-%m-%dT%H:%M:%SZ")
                    due_date = lr_date.timestamp() + (days * 86400)
                    if now_ts > due_date:
                        overdue.append(s['name'])
                except ValueError:
                    pass

    try:
        with open('secrets/inventory.yaml', 'w') as f:
            yaml.dump(inventory_data, f, sort_keys=False)
    except Exception as e:
        print(f"::warning::Failed to write inventory: {e}")

    if overdue:
        print(f"::error::The following secrets are overdue for rotation: {', '.join(overdue)}")
        sys.exit(1)
