#!/usr/bin/env node

/**
 * Extract key metrics from k6 JSON output for baseline comparison.
 * Usage: node scripts/extract-load-test-metrics.js <load-test-results.json>
 *
 * Outputs a JSON summary with p50, p95, p99 latencies for key endpoints.
 */

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node scripts/extract-load-test-metrics.js <load-test-results.json>');
  process.exit(1);
}

// Read and parse k6 JSON output
let rawData;
try {
  rawData = fs.readFileSync(inputFile, 'utf8');
} catch (err) {
  console.error(`Failed to read input file: ${err.message}`);
  process.exit(1);
}

const lines = rawData.trim().split('\n');
const metrics = {
  timestamp: new Date().toISOString(),
  git_commit: process.env.GITHUB_SHA || 'unknown',
  donation: {},
  analytics: {}
};

// Parse k6 JSON lines and extract metrics
for (const line of lines) {
  if (!line.trim()) continue;

  try {
    const data = JSON.parse(line);
    
    // Extract http_req_duration metrics (general latency)
    if (data.type === 'Point' && data.metric === 'http_req_duration') {
      const value = data.data;
      if (!metrics.general) {
        metrics.general = { values: [] };
      }
      metrics.general.values.push(value);
    }

    // Extract donation_latency metrics
    if (data.type === 'Point' && data.metric === 'donation_latency') {
      const value = data.data;
      if (!metrics.donation.values) {
        metrics.donation.values = [];
      }
      metrics.donation.values.push(value);
    }

    // Extract analytics_latency metrics
    if (data.type === 'Point' && data.metric === 'analytics_latency') {
      const value = data.data;
      if (!metrics.analytics.values) {
        metrics.analytics.values = [];
      }
      metrics.analytics.values.push(value);
    }

    // Extract summary metrics if available
    if (data.type === 'Summary') {
      if (data.metric === 'http_req_duration' && data.data) {
        metrics.general.p50 = data.data.values['p(50)'];
        metrics.general.p95 = data.data.values['p(95)'];
        metrics.general.p99 = data.data.values['p(99)'];
        metrics.general.avg = data.data.values.avg;
      }
      if (data.metric === 'donation_latency' && data.data) {
        metrics.donation.p50 = data.data.values['p(50)'];
        metrics.donation.p95 = data.data.values['p(95)'];
        metrics.donation.p99 = data.data.values['p(99)'];
        metrics.donation.avg = data.data.values.avg;
      }
      if (data.metric === 'analytics_latency' && data.data) {
        metrics.analytics.p50 = data.data.values['p(50)'];
        metrics.analytics.p95 = data.data.values['p(95)'];
        metrics.analytics.p99 = data.data.values['p(99)'];
        metrics.analytics.avg = data.data.values.avg;
      }
    }
  } catch (err) {
    // Skip lines that can't be parsed
    continue;
  }
}

// Calculate percentiles from raw values if summary not available
function calculatePercentiles(values) {
  if (!values || values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  const p50 = sorted[Math.floor(len * 0.5)];
  const p95 = sorted[Math.floor(len * 0.95)];
  const p99 = sorted[Math.floor(len * 0.99)];
  const avg = sorted.reduce((sum, val) => sum + val, 0) / len;

  return { p50, p95, p99, avg };
}

// Calculate percentiles if not available from summary
if (metrics.general?.values && !metrics.general.p50) {
  const calculated = calculatePercentiles(metrics.general.values);
  if (calculated) {
    Object.assign(metrics.general, calculated);
  }
  delete metrics.general.values;
}

if (metrics.donation?.values && !metrics.donation.p50) {
  const calculated = calculatePercentiles(metrics.donation.values);
  if (calculated) {
    Object.assign(metrics.donation, calculated);
  }
  delete metrics.donation.values;
}

if (metrics.analytics?.values && !metrics.analytics.p50) {
  const calculated = calculatePercentiles(metrics.analytics.values);
  if (calculated) {
    Object.assign(metrics.analytics, calculated);
  }
  delete metrics.analytics.values;
}

// Output the metrics summary
console.log(JSON.stringify(metrics, null, 2));