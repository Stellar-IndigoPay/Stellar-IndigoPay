# Flaky Test Quarantine

This repository employs a flaky test quarantine policy to prevent intermittent failures from eroding trust in CI gates.

## What is a flaky test?
A flaky test is a test that sometimes passes and sometimes fails without any changes to the code.

## The Quarantine Process
When the nightly `flake-detection` workflow identifies a test as flaky, it must be quarantined immediately to unblock CI.

1. **Identify**: Find the test name/file from the `flake-detection` report.
2. **Quarantine**: Mark the test as skipped or flaky in the source code using the test runner's native skipping functionality (e.g., `test.skip` or `it.skip` in Jest/Playwright).
3. **Track**: Add an entry in this document under "Quarantined Tests".
4. **Fix**: Create a GitHub issue to investigate and fix the root cause of the flakiness. Link the issue in this document.
5. **Restore**: Once fixed and proven stable, remove the skip, delete the entry here, and close the issue.

## Quarantined Tests

| Test Name / File | Date Quarantined | Tracking Issue | Notes |
| :--- | :--- | :--- | :--- |
| (Example) `should process concurrent payments` in `payment.spec.js` | 2026-08-19 | #1234 | Fails randomly when mock DB takes > 50ms |
