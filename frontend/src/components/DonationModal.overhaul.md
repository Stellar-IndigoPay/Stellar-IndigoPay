DonationModal Overhaul Plan

Goals:
- Animated confirmation (checkmark, thank you fade-in)
- Share section (Twitter, copy link, download certificate)
- Donate again flows back to the form

Implementation notes:
- Prefer `framer-motion` if already in dependencies; fallback to CSS animations
- Use existing `ShareButton.tsx` and `ImpactCertificate.tsx`
- Accessibility: focus management, reduced motion

Tests:
- `frontend/__tests__/DonationModal.test.tsx` to verify rendering and donate-again

TODO: implement `DonationModal.tsx` and integrate with donation flow.
