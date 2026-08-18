DonateForm Overhaul Plan

This file is a scaffold describing the planned changes for `DonateForm.tsx`.

Goals:
- Real-time balance display and polling
- Max button (balance - fees - reserve)
- Fee estimator using stellar-sdk transaction build
- Real-time validation states (green check, red error, yellow warning)
- Amount presets and impact preview

Implementation notes:
- Use existing `useWallet()` from `frontend/lib/WalletProvider.tsx`
- Use `AnimatedNumber` for balance and CO2 impact
- Respect `prefers-reduced-motion`
- Accessibility: labels, role="alert" for errors, keyboard navigation

Tests:
- Add `frontend/__tests__/DonateForm.test.tsx` with unit tests for validation and max button

TODO: implement `DonateForm.tsx` and wire into `frontend/pages` where needed.
