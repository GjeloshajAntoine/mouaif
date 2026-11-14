# Interactive chat UI review mockup — implementation notes

Public page: [`docs/features/chat-review-mockup.md`](../../features/chat-review-mockup.md).

The route is implemented in `frontend/src/components/ChatReviewMockup.jsx` with isolated styles in `frontend/src/chat-review-mockup.css`. It is intentionally separate from the production transcript state so design review can happen against a real production build without creating database fixtures. The layout is mobile-first at 360–430 CSS pixels and expands to a four-direction comparison row on wider screens.

The Docker review stack is documented in [UI review in Docker](../../features/ui-review-docker.md).
