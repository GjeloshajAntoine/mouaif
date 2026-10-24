# Interactive chat UI review mockup

## Overview

The chat review mockup is a safe, synthetic conversation for reviewing mouaif's mobile chat experience in Docker. It combines current product UI patterns with four common design directions: calm utility, glassmorphism, editorial warmth, and terminal-inspired command surfaces.

## Usage

Open the production app at:

```text
http://127.0.0.1:5732/#/chat-review-mockup
```

Tap a direction to change the palette and visual mood. Tap the completed tool row to expand its details. Use a suggested prompt to populate the composer, or type and send a message to append a synthetic assistant response.

The mockup does not call a provider, execute a tool, write a chat, or change project settings. All content and responses are local to the page.

## Implementation notes

The route is implemented in `frontend/src/components/ChatReviewMockup.jsx` with isolated styles in `frontend/src/chat-review-mockup.css`. It is intentionally separate from the production transcript state so design review can happen against a real production build without creating database fixtures. The layout is mobile-first at 360–430 CSS pixels and expands to a four-direction comparison row on wider screens.

The Docker review stack is documented in [UI review in Docker](./ui-review-docker.md).
