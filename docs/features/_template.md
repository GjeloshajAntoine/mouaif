# <Feature name>

<!--
  Copy this file to docs/features/<kebab-case-name>.md when adding a new feature.
  Must be self-contained and deployable as a static page (no SSG-specific shortcodes).
  Update docs/README.md index in the same commit.

  Keep it short and scannable on a phone. Aim for a few hundred words, not a few
  thousand: this page is read, not audited. Public pages have been rewritten from
  10,000 words down to ~1,500, and that is the target shape.
    - One to two sentences per bullet. Put the rule first, the reason second.
    - No measurements, before/after tables, or "we tried X and rejected it"
      stories. Those belong in docs/agent/features/<same-name>.md.
    - Prefer a table or a numbered walkthrough over long prose.
-->

## Overview

One to three sentences describing what the feature does and why it exists.

## Usage

How the user interacts with it. Include code blocks with a language tag.

````markdown
```bash
mouaif <command>
```
````

## Behavior

- Bullet list of observable behavior, one to two sentences each.
- Defaults, limits, side effects.

## Related

- Links to other `docs/features/*.md` files this depends on or complements.

<!--
  Everything with a "why", a measurement, a rejected alternative, or a source
  path goes in docs/agent/features/<same-name>.md, which is never published.
  Keep this page to what a user of the app sees and does.
-->

