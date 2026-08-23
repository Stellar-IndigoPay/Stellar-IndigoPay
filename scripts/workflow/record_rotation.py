"""Build the audit log payload for secret rotation and POST it to the admin API."""
import json, os, sys, urllib.request, urllib.error

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
