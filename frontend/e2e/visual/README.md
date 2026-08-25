# Visual Regression Tests

These tests use Playwright to take full-page screenshots of critical routes (Home, Project Detail, Leaderboard, Donate, Governance, Dashboard) in both Light and Dark modes.

## How to Update Baselines

If you make an intentional design change that causes the `frontend-visual.yml` CI job to fail, you need to update the approved baselines. 

Since snapshots are OS and font-render specific, generating them locally on macOS or Windows will likely cause mismatches in the Ubuntu-based CI runner. 

**Recommended process:**
1. Let the CI job fail.
2. Go to the failing GitHub Action run.
3. Download the `playwright-visual-report` artifact.
4. Review the diffs in the report to ensure the changes are expected.
5. If expected, you can either:
   - Extract the `-actual.png` files from the report and overwrite the existing snapshots in `frontend/e2e/visual/visual.spec.ts-snapshots/` (renaming them to remove `-actual`).
   - Run the tests locally inside a Docker container that matches the CI environment:
     ```bash
     docker run --rm --network host -v $(pwd):/work/ -w /work/frontend -it mcr.microsoft.com/playwright:v1.44.1-jammy /bin/bash
     npm ci
     npx playwright test e2e/visual/visual.spec.ts --update-snapshots
     ```
6. Commit the updated baseline images and push to your PR.
