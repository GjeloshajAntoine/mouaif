# Chat UI themes for implementation

## Overview

The chat UI theme direction is a deliberately composed system rather than a single visual skin. It uses an Apple-inspired mobile shell, Material 3 interaction patterns, Editorial typography for assistant answers, and a restrained Neo-brutalist treatment only for high-signal tool actions. The themes are mobile-first and preserve the existing chat data model, authorization semantics, streaming behavior, and composer controls.

The design reference is previewed in the on-the-fly MCP App at `Chat UI design review`. The preview is synthetic: it does not call providers, execute tools, change settings, or write chat state.

## Usage

Use the MCP App to compare the four layers and their feedback states:

- **Material actions** — colorful status roles, tonal surfaces, chips, clear primary actions, and navigation.
- **Apple shell** — translucent grouped surfaces, safe-area-aware mobile framing, floating composer, contextual sheets, and restrained depth.
- **Editorial answers** — readable response hierarchy, serif answer headings, pull quotes, source labels, and generous measure.
- **Neo tool actions** — high-contrast approvals and execution controls only; never apply hard borders or offset shadows to the Material chat surface.

The recommended production composition is:

```text
Apple shell
├── Material status and action patterns
├── Editorial assistant response content
└── Neo-brutalist tool approval / high-risk action treatment
```

## Shared chat elements

Every direction renders the same chat elements, in the same order and with the same copy:

1. Header — back, chat title, model and status, thinking level, options
2. Run status — run outcome, duration, and context size
3. User message
4. Assistant answer — kicker, heading, body, pull quote, and Copy / Retry / Sources actions
5. Tool row — expandable, with the tool names and total duration
6. Tool approval — the command, the working folder, and Allow once / Allow session / Deny
7. Composer — attach, message, and send
8. Section tabs — Chat, Files, and More

Directions change only the styling, not the structure. The hybrid, Neo, and Editorial previews share one template (`chatView(theme)`) and one set of components, styled by `--cv-*` tokens: surfaces, ink, accent, user bubble, status colours, tool and approval colours, radii, border width, shadow, and reading font. Each direction adds a short block of accent rules on top. Apple and Smoked glass keep their own markup for the glass engine, but show the same elements and copy, and the approval follows the tool row.

The "Chat elements in this conversation" catalog uses the same tokens as the selected direction, and Smoked glass has its own catalog styling. Each entry is a row with an icon, a title, metadata, and an optional status pill. The catalog reuses the preview's components, including the action chips, approval buttons, and composer. Tool records show partial success as a warning (`PARTIAL`) rather than `DONE`.

## Prototype review improvements

The Apple comparison uses a quiet iOS-style grouped background, white inset groups, system-blue message bubbles, and system typography. Liquid Glass-inspired treatment is restricted to the composer and navigation: circular translucent toolbar controls, a floating capsule tab bar, a tonal selected capsule, subtle edge highlights, and matching outline icons. A faint static tint behind the chrome supplies depth while reading surfaces remain opaque. Increased-contrast mode makes the glass opaque and strengthens control edges. Simulated hardware islands and bouncing cards are removed. The Apple prototype implements a bounded transcript that scrolls beneath fixed glass controls. Each control sits over a clipped, filtered mirror of the transcript; see Liquid glass controls below. Options → Toggle lens test pattern adds a striped backdrop for checking real bending separately from highlights; the pattern is off by default. Increased contrast and the opaque-control setting disable refraction. This is a web implementation, not Apple's proprietary native Liquid Glass renderer.

Apple's Chat, Files, and More controls switch actual local views. The composer appends safely rendered plain-text messages, and the attachment picker lists local filename/size metadata without uploading or reading file contents. The options sheet supports Escape, focus containment/restoration, attachment navigation, and an opaque-control toggle. State lasts until the theme is switched; no provider requests, tool execution, or settings writes occur. The Material comparison uses explicit body and metadata sizes rather than inherited `1em` sizing, preserving its answer/avatar layout on phones.

The MCP preview uses larger mobile text and 44-pixel minimum button targets. Theme tabs support Left/Right arrows, Home, and End, with visible keyboard focus and an associated preview panel. Reduced-motion mode disables decorative animation throughout the study.

Submitting the composer inserts a plain-text sample message locally; it does not contact an AI provider. Switching themes resets this temporary conversation. Copy feedback is shown only after clipboard access succeeds, with an explicit unavailable message when access fails.

The local prototype is `.mouaif/mcp-apps/3c75b58bebdd1020626c3218.html`; this app-storage file is not part of the production frontend bundle.

## Liquid glass controls

The toolbar buttons, composer, and tab bar refract the live transcript in every engine. Each control has a clipped copy of the transcript painted beneath it. The copy stays aligned on scroll and is re-cloned when the content changes. An ordinary SVG `filter` refracts it; `url()` inside `backdrop-filter` is not used because only Chromium supports it.

- **Optics** — each lens traces a ray per pixel through a thick convex squircle bezel. The ray bends by Snell's law and then travels through the local glass height to the transcript, so the displacement grows with both slope and thickness. Red, green, and blue use different refractive indices (Cauchy dispersion), and red is also displaced further and blue less. The rainbow fringes then span the whole bevel and the edges of content inside the glass, and are strongest where the bezel is steepest. The saturation boost keeps them vivid. The flat interior is a gently magnifying slab. Near the rim the content folds back into mirrored caustics, as it does in thick glass. A gentle lift brightens the glass. The Glass lab's Refraction slider scales the glass thickness and its Rainbow edge slider scales both the index spread and the channel displacement. The controls have no blur by default.
- **Live light** — a thin conic-gradient rim and an inner sheen follow the pointer, or device tilt where `deviceorientation` is available, with a weaker glint on the opposite edge.
- **Edge lighting** — a normal map stores each pixel's bevel tilt. A key light and a softer back glint are lit as dot products of that normal with the light direction, sharpened into a specular lobe, and both turn with the pointer or device tilt. The flat interior is neutral, so only the bevel catches light. The adaptive tint is drawn inside the filter, beneath the Fresnel reflection and the highlights, so dark glass keeps bright white edges. A colourless hairline rim marks the outer edge. Colour at the border comes only from refracted content, never from paint.
- **Environment reflection** — each lens reaches 32 pixels past its control. The bevel mirrors that surrounding content across its edge, weighted by Fresnel reflectance so it is strongest at the rim. Colourful content near a control lights its edge before it passes underneath.
- **Jelly press** — controls and their lenses scale on an underdamped spring when pressed, which also magnifies the content beneath. The send button is a tinted glass bead.
- **Liquid tab droplet** — the selected tab sits on a glass bead. Pressing lifts it and magnifies the label underneath. Dragging stretches it with velocity, and releasing snaps it to the nearest tab and opens that tab. Keyboard and tap activation are unchanged.
- **Adaptive tone** — each control samples the luminance behind it across a grid of points, from canvas pixels or the nearest opaque background. Over dark content it switches to dark glass with light labels, with hysteresis so it does not flicker. A control that only partly overlaps dark content keeps its tone.
- **Glass lab** — Options → Glass lab tunes refraction, rainbow edge, frost, and tint live, while the dock stays visible.

One `requestAnimationFrame` loop drives everything and stops when the springs settle. Displacement maps are rebuilt only when a control's size or the lab settings change. Reduced motion turns off the springs and pointer lighting. Opaque controls and increased contrast remove refraction and make the glass white.

## Smoked glass

Smoked glass is a separate theme tab that reuses the Apple shell and the liquid glass engine. The transcript stays light, as in the Apple theme. The chrome (toolbar buttons, composer, and tab bar) is always dark smoked glass instead of sampling the content behind it, with a deeper tint so it reads as dark glass over white rather than grey. The Apple theme's blue send bead is reused unchanged. Its style (a radial highlight that follows the light over `#007aff`) also applies to user bubbles, Allow once, and the tab droplet.

## Canvas optical demo

The Apple preview includes a labelled, draggable canvas lens over a synthetic scene. JavaScript samples scene pixels with capsule-shaped refraction, separate RGB offsets, and edge lighting; Disable lens provides a direct comparison. Arrow keys move the lens too. Rendering is bounded and event-driven, with resize observers disconnected on theme changes.

Canvas cannot sample arbitrary DOM content. This demo does not refract the live transcript. The chat controls refract the live transcript with the same optics; see Liquid glass controls. The canvas scene makes actual pixel distortion independently testable without claiming native Apple rendering.

## Implementation notes

### Apple-inspired mobile shell

Use the Apple layer for the page frame and navigation, not as a literal platform clone:

- Respect `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`.
- Keep a large project/chat title that can collapse as the transcript scrolls.
- Use grouped rows for model, context, files, sources, and usage.
- Use one translucent composer surface; do not stack several floating inputs.
- Use bottom tabs or a bottom sheet for secondary context.
- Keep blur, tint, and shadow subtle enough that text and tool status remain legible.
- Make every interaction work by tap; hover is enhancement only.

Suggested structure:

```html
<section class="chat-shell chat-shell--glass">
  <header class="chat-shell__header">…</header>
  <div class="chat-shell__transcript">…</div>
  <form class="chat-shell__composer">…</form>
  <nav class="chat-shell__tabs">…</nav>
</section>
```

### Material 3 interaction language

Use Material 3 for meaning and action hierarchy:

- Assign semantic colors to success, running, warning, error, and approval states.
- Use tonal containers for context banners, source rows, tool results, and action chips.
- Use rounded controls with clear primary/secondary distinction.
- Use chips for compact actions such as Copy, Retry, Sources, and Attach.
- Keep the primary send action visually dominant but not oversized.
- Use live status text alongside color; color must not be the only signal.

The Material preview must not use Neo-brutalist styling. Tool cards in this layer use rounded corners, tonal surfaces, and soft elevation.

### Editorial assistant answers

Use Editorial treatment for the answer body only:

- Give the assistant answer a readable title when the response has a clear conclusion.
- Use a serif or reading-optimized face for long-form answer content.
- Keep metadata, model name, timestamp, and token details in a compact sans-serif treatment.
- Use pull quotes or callouts sparingly for the key recommendation.
- Keep code, tables, markdown links, and citations structurally clear.
- Do not turn every short answer into a magazine article; apply the hierarchy only when the content warrants it.

### Neo-brutalist tool actions

Limit the Neo layer to actions where immediate recognition matters:

- Tool approval cards
- Allow once / Allow session / Always allow / Deny controls
- Destructive or high-risk operations
- Failed tool results that need explicit attention
- Retry or recovery controls after a failed run

Use thick borders, hard shadows, and direct labels only on those action surfaces. Do not apply them to the chat header, assistant answer, composer, or ordinary source cards.

### Tool and chat element data

The visual treatment must preserve the full visible chat element set:

- Chat identity, project, model, and thinking level
- User messages and assistant responses
- Markdown, code, citations, and response actions
- Attachments and selected context
- Tool calls, arguments, authorization, working folder, timing, duration, output, stderr, exit codes, and retry state
- Pending approvals and their decision scope
- Progress, running, paused, completed, partial-success, and failed states
- Context tokens, output tokens, total tokens, cost, cache status, and speed
- Composer draft, image, microphone, file, and send states
- Live connection, scroll position, and run-settled state

Tool details should be expandable inline where the tool appears. Avoid moving the user to a separate technical dashboard just to understand the current conversation.

### Feedback states

Effects should communicate state changes and causality:

| State | Feedback | Required information |
| --- | --- | --- |
| Success | Check icon, tonal success surface, short confirmation | What completed and the result |
| Running | Activity indicator and bounded progress | Current step, count, and elapsed time |
| Paused | Warning tint and explicit pause label | Why it is paused and what the user must do |
| Approval | Focused sheet/card with clear actions | Tool, command, folder, and permission scope |
| Failure | Error styling plus retry action | Error summary, stderr/output, and recovery path |
| Partial success | Warning status with counts | Succeeded, failed, and skipped items |
| Dismissed | In-place state update or toast | The decision that was made |
| Copied / attached | Short live toast | What was copied or attached |

Motion is optional feedback, not decoration:

- Animate only the changed surface.
- Use short transform/opacity transitions for insertion, expansion, and dismissal.
- Respect `prefers-reduced-motion: reduce`.
- Never require animation or hover to discover a state.
- Use focus-visible outlines for keyboard users.

Example state markup:

```html
<article class="tool-card tool-card--running" aria-live="polite">
  <header class="tool-card__header">
    <span class="tool-card__status" aria-hidden="true">◌</span>
    <strong>search_files</strong>
    <span>3 of 4 files</span>
  </header>
  <div class="tool-card__progress" aria-label="Reading sources, 75 percent"></div>
</article>
```

### Mobile constraints

- Design first for 360–430 CSS pixels.
- Keep interactive controls at least 44 × 44 pixels where their box is the hit target.
- Use a single-column transcript on phones.
- Keep long tool output inside a bounded, independently scrollable region.
- Avoid fixed-width cards and desktop-only hover affordances.
- Preserve composer visibility when the virtual keyboard opens.
- Test light and dark contrast, large text, reduced motion, and touch interaction.

### Recommended rollout

1. Extract shared shell, status, chip, sheet, and feedback tokens.
2. Apply the Apple-inspired shell to the existing chat route.
3. Apply Material status and action primitives to messages, tools, usage, and composer controls.
4. Apply Editorial hierarchy conditionally to long assistant responses.
5. Apply Neo treatment only to approval, high-risk, failure, and recovery cards.
6. Verify streaming, tool authorization, retry, draft preservation, and scroll behavior against the existing chat tests.

The theme layer must remain presentation-only. It must not change provider requests, tool authorization, transcript persistence, streaming events, or chat routing.
