# Theme mockup

## Overview
The theme mockup is a lightweight visual study for a more expressive chat surface. It keeps the conversation readable while comparing three deliberately different moods: Aurora, Paper, and Mono.

## Usage
Open `#/theme-mockup` in the running app. Tap a theme chip to switch the complete mockup palette and effects without leaving the conversation.

## Implementation notes
The prototype lives in `frontend/src/components/ThemeMockup.jsx` and `frontend/src/theme-mockup.css`. It is intentionally isolated from the production chat state so visual review is safe and reversible. The layout is mobile-first, with larger spacing at desktop widths.
