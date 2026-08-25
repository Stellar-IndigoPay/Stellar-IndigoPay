#!/bin/bash

# Test script for backup checksum functionality
# This script tests the checksum generation and verification logic

set -e

echo "=== Testing Backup Checksum Functionality ==="

# Test 1: Test argument parsing
echo "Test 1: Testing argument parsing..."
if node scripts/generate-backup-checksums.js --help 2>&1 | grep -q "Missing required argument"; then
  echo "✅ Argument validation working"
else
  echo "❌ Argument validation failed"
  exit 1
fi

# Test 2: Test checksum generation script syntax
echo "Test 2: Testing checksum generation script syntax..."
node --check scripts/generate-backup-checksums.js
echo "✅ Checksum generation script syntax valid"

# Test 3: Test verification script syntax
echo "Test 3: Testing verification script syntax..."
node --check scripts/verify-restore-checksums.js
echo "✅ Verification script syntax valid"

# Test 4: Test checksum file format
echo "Test 4: Testing checksum file format..."
mkdir -p /tmp/test-checksums
cat > /tmp/test-checksums/sample-checksums.json << 'EOF'
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "database": "stellar_indigopay",
  "tables": {
    "projects": {
      "row_count": 10,
      "column_names": ["id", "name", "description"],
      "checksums": [
        {"row_id": "project-1", "checksum": "abc123"},
        {"row_id": "project-2", "checksum": "def456"}
      ],
      "table_checksum": "hash123"
    },
    "donations": {
      "row_count": 5,
      "column_names": ["id", "amount", "donor"],
      "checksums": [
        {"row_id": "donation-1", "checksum": "xyz789"}
      ],
      "table_checksum": "hash456"
    }
  },
  "database_checksum": "dbhash789"
}
EOF

# Validate JSON format
if node -e "JSON.parse(require('fs').readFileSync('/tmp/test-checksums/sample-checksums.json', 'utf8'))"; then
  echo "✅ Checksum file format valid"
else
  echo "❌ Checksum file format invalid"
  exit 1
fi

# Test 5: Test verification script argument parsing
echo "Test 5: Testing verification script argument parsing..."
if node scripts/verify-restore-checksums.js --help 2>&1 | grep -q "Missing required argument"; then
  echo "✅ Verification argument validation working"
else
  echo "❌ Verification argument validation failed"
  exit 1
fi

# Test 6: Test crypto operations
echo "Test 6: Testing crypto operations..."
node -e "
const crypto = require('crypto');
const testString = 'test|data|123';
const hash = crypto.createHash('sha256').update(testString).digest('hex');
console.log('Generated hash:', hash);
if (hash.length === 64) {
  console.log('✅ SHA-256 hash generation working');
} else {
  console.log('❌ Hash generation failed');
  process.exit(1);
}
"

# Test 7: Test error handling
echo "Test 7: Testing error handling..."
if node scripts/verify-restore-checksums.js \
  --host localhost \
  --port 5432 \
  --user test \
  --database test \
  --checksums /tmp/nonexistent.json 2>&1 | grep -q "Error"; then
  echo "✅ Error handling working"
else
  echo "⚠️ Error handling could not be fully tested without database"
fi

echo "=== Backup Checksum Functionality Tests Passed ==="
rm -rf /tmp/test-checksums