# Chat UI themes for implementation — implementation notes

Public page: [`docs/features/chat-ui-themes.md`](../../features/chat-ui-themes.md).

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
