#!/bin/bash

# Test script for performance regression detection
# This script simulates the workflow without requiring full infrastructure

set -e

echo "=== Testing Performance Regression Detection ==="

# Test 1: Create sample k6 output
echo "Test 1: Creating sample k6 JSON output..."
mkdir -p /tmp/test-perf
cat > /tmp/test-perf/sample-k6.json << 'EOF'
{"type":"Point","metric":"http_req_duration","data":150}
{"type":"Point","metric":"http_req_duration","data":180}
{"type":"Point","metric":"http_req_duration","data":120}
{"type":"Point","metric":"donation_latency","data":140}
{"type":"Point","metric":"donation_latency","data":160}
{"type":"Point","metric":"donation_latency","data":130}
{"type":"Summary","metric":"http_req_duration","data":{"values":{"p(50)":150,"p(95)":180,"p(99)":190,"avg":150}}}
{"type":"Summary","metric":"donation_latency","data":{"values":{"p(50)":140,"p(95)":160,"p(99)":170,"avg":143.33}}}
EOF

# Test 2: Extract metrics
echo "Test 2: Extracting metrics from k6 output..."
node scripts/extract-load-test-metrics.js /tmp/test-perf/sample-k6.json > /tmp/test-perf/metrics-summary.json
echo "✅ Metrics extraction successful"
cat /tmp/test-perf/metrics-summary.json

# Test 3: Create baseline and current for comparison
echo "Test 3: Testing comparison logic..."
cat > /tmp/test-perf/baseline.json << 'EOF'
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "git_commit": "baseline123",
  "donation": {
    "p50": 100,
    "p95": 120,
    "p99": 130,
    "avg": 110
  },
  "analytics": {
    "p50": 80,
    "p95": 100,
    "p99": 110,
    "avg": 90
  }
}
EOF

cat > /tmp/test-perf/current.json << 'EOF'
{
  "timestamp": "2024-01-02T00:00:00.000Z",
  "git_commit": "current456",
  "donation": {
    "p50": 120,
    "p95": 150,
    "p99": 160,
    "avg": 130
  },
  "analytics": {
    "p50": 90,
    "p95": 110,
    "p99": 120,
    "avg": 100
  }
}
EOF

# Test 4: Compare metrics with 20% threshold
echo "Test 4: Comparing metrics with 20% threshold..."
node scripts/compare-perf-metrics.js /tmp/test-perf/baseline.json /tmp/test-perf/current.json 20 > /tmp/test-perf/comparison.json
echo "✅ Comparison successful"
cat /tmp/test-perf/comparison.json

# Test 5: Check for regression detection
echo "Test 5: Checking regression detection..."
if grep -q "regression_detected.*true" /tmp/test-perf/comparison.json; then
  echo "✅ Regression correctly detected (donation p50 increased from 100ms to 120ms = 20% threshold breach)"
else
  echo "❌ Regression detection failed"
  exit 1
fi

# Test 6: Test with acceptable changes
echo "Test 6: Testing with acceptable changes (10% threshold)..."
cat > /tmp/test-perf/current-good.json << 'EOF'
{
  "timestamp": "2024-01-02T00:00:00.000Z",
  "git_commit": "current456",
  "donation": {
    "p50": 105,
    "p95": 125,
    "p99": 135,
    "avg": 115
  },
  "analytics": {
    "p50": 82,
    "p95": 102,
    "p99": 112,
    "avg": 92
  }
}
EOF

node scripts/compare-perf-metrics.js /tmp/test-perf/baseline.json /tmp/test-perf/current-good.json 20 > /tmp/test-perf/comparison-good.json
if grep -q "regression_detected.*false" /tmp/test-perf/comparison-good.json; then
  echo "✅ No regression correctly detected for acceptable changes"
else
  echo "❌ False positive detected"
  exit 1
fi

echo "=== Performance Regression Detection Tests Passed ==="
rm -rf /tmp/test-perf