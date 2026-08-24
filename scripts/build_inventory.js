const fs = require('fs');
const envFiles = ['backend/.env.example', 'frontend/.env.example', 'mobile/.env.example'];
const inventory = { secrets: [] };
const varsSeen = new Set();
envFiles.forEach(file => {
    if (!fs.existsSync(file)) return;
    const scope = file.split('/')[0];
    const content = fs.readFileSync(file, 'utf-8');
    content.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        if (line.includes('=')) {
            const varName = line.split('=')[0];
            if (!varsSeen.has(varName)) {
                varsSeen.add(varName);
                const isSecret = ['SECRET', 'KEY', 'PASSWORD', 'TOKEN'].some(s => varName.toUpperCase().includes(s)) || ['DATABASE_URL', 'REDIS_URL'].includes(varName);
                const classification = isSecret ? 'secret' : 'public';
                const rotationPeriod = ['DATABASE_URL', 'JWT_SECRET', 'WEBHOOK_SIGNING_SECRET', 'ADMIN_API_KEY', 'RECEIPT_SIGNING_KEY', 'ORACLE_ADMIN_SECRET', 'RECURRING_SIGNER_SECRET'].includes(varName) ? '90d' : null;
                inventory.secrets.push({
                    name: varName,
                    store_key: isSecret ? varName : null,
                    scope,
                    rotation_period: rotationPeriod,
                    last_rotation: rotationPeriod ? '2024-01-01T00:00:00Z' : null,
                    owner: scope === 'backend' ? 'backend-team' : 'frontend-team',
                    classification
                });
            }
        }
    });
});
['WEBHOOK_SIGNING_SECRET', 'ADMIN_API_KEY', 'ORACLE_ADMIN_SECRET', 'RECURRING_SIGNER_SECRET'].forEach(extra => {
    if (!varsSeen.has(extra)) {
        inventory.secrets.push({
            name: extra,
            store_key: extra,
            scope: 'backend',
            rotation_period: '90d',
            last_rotation: '2024-01-01T00:00:00Z',
            owner: 'backend-team',
            classification: 'secret'
        });
    }
});
fs.mkdirSync('secrets', { recursive: true });
const yaml = inventory.secrets.map(s => {
    return `- name: ${s.name}
  store_key: ${s.store_key}
  scope: ${s.scope}
  rotation_period: ${s.rotation_period}
  last_rotation: ${s.last_rotation}
  owner: ${s.owner}
  classification: ${s.classification}`;
}).join('\n');
fs.writeFileSync('secrets/inventory.yaml', 'secrets:\n' + yaml + '\n');
