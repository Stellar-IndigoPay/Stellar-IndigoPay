#!/usr/bin/env node

/**
 * Compare performance metrics between baseline and current run.
 * Usage: node scripts/compare-perf-metrics.js <baseline.json> <current.json> [threshold_pct]
 *
 * Outputs JSON with comparison results and regression detection.
 */

const fs = require('fs');
const path = require('path');

const baselineFile = process.argv[2];
const currentFile = process.argv[3];
const thresholdPct = parseFloat(process.argv[4]) || 20;

if (!baselineFile || !currentFile) {
  console.error('Usage: node scripts/compare-perf-metrics.js <baseline.json> <current.json> [threshold_pct]');
  process.exit(1);
}

// Read baseline and current metrics
let baselineData, currentData;
try {
  baselineData = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  currentData = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
} catch (err) {
  console.error(`Failed to read metrics files: ${err.message}`);
  process.exit(1);
}

const result = {
  threshold_pct: thresholdPct,
  regression_detected: false,
  baseline_commit: baselineData.git_commit || 'unknown',
  current_commit: currentData.git_commit || 'unknown',
  baseline_timestamp: baselineData.timestamp,
  current_timestamp: currentData.timestamp,
  metrics: {}
};

// Compare metrics
function compareMetric(name, baselineValue, currentValue) {
  if (baselineValue === null || baselineValue === undefined || 
      currentValue === null || currentValue === undefined) {
    return null;
  }

  const change = currentValue - baselineValue;
  const changePct = baselineValue > 0 ? (change / baselineValue) * 100 : 0;
  
  return {
    baseline: baselineValue,
    current: currentValue,
    change: change,
    change_pct: changePct,
    exceeds_threshold: changePct > thresholdPct
  };
}

// Compare donation metrics
if (baselineData.donation && currentData.donation) {
  const donationMetrics = ['p50', 'p95', 'p99', 'avg'];
  for (const metric of donationMetrics) {
    const comparison = compareMetric(
      `donation_${metric}`,
      baselineData.donation[metric],
      currentData.donation[metric]
    );
    if (comparison) {
      result.metrics[`donation_${metric}`] = comparison;
      if (comparison.exceeds_threshold) {
        result.regression_detected = true;
      }
    }
  }
}

// Compare analytics metrics
if (baselineData.analytics && currentData.analytics) {
  const analyticsMetrics = ['p50', 'p95', 'p99', 'avg'];
  for (const metric of analyticsMetrics) {
    const comparison = compareMetric(
      `analytics_${metric}`,
      baselineData.analytics[metric],
      currentData.analytics[metric]
    );
    if (comparison) {
      result.metrics[`analytics_${metric}`] = comparison;
      if (comparison.exceeds_threshold) {
        result.regression_detected = true;
      }
    }
  }
}

// Compare general HTTP metrics
if (baselineData.general && currentData.general) {
  const generalMetrics = ['p50', 'p95', 'p99', 'avg'];
  for (const metric of generalMetrics) {
    const comparison = compareMetric(
      `http_${metric}`,
      baselineData.general[metric],
      currentData.general[metric]
    );
    if (comparison) {
      result.metrics[`http_${metric}`] = comparison;
      if (comparison.exceeds_threshold) {
        result.regression_detected = true;
      }
    }
  }
}

// Output comparison result
console.log(JSON.stringify(result, null, 2));