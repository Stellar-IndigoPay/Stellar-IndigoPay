---
title: Rate Limit Exhaustion and Spike Incident Response
severity: warn
owners:
  - "@oncall-team"
symptoms:
  - "More than 10% of HTTP requests rejected with HTTP 429"
  - "Per-endpoint rate limit spike (>5/s for 5m)"
  - "Token bucket exhausted on critical API routes"
steps:
  - "Identify client IP addresses or user agents causing rate limit hits from NGINX/Ingress logs."
  - "Verify if traffic pattern is malicious (DDoS / scraper) or a legitimate client retry loop."
  - "If legitimate traffic spike, dynamically increase token bucket capacity in ConfigMap."
  - "If abusive IP, block at Web Application Firewall (WAF) or Ingress NetworkPolicy level."
verification:
  - "Confirm HTTP 429 error rate returns to normal baseline."
rollback:
  - "Restore default rate limit parameters."
---

# Rate Limit Exhaustion Runbook

## Overview
Triggered when rate limiting thresholds block excessive traffic.

## Mitigation
1. Inspect Ingress request logs for top requesting IPs.
2. Adjust rate limit configs or block abusive client traffic.
