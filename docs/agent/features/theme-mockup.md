# Theme mockup — implementation notes

Public page: [`docs/features/theme-mockup.md`](../../features/theme-mockup.md).

The prototype lives in `frontend/src/components/ThemeMockup.jsx` and `frontend/src/theme-mockup.css`. It is intentionally isolated from the production chat state so visual review is safe and reversible. The layout is mobile-first, with larger spacing at desktop widths.
