# File button: glass orb

## Overview

Settings → App defaults → Chat defaults has a **Glass orb file button** switch. With it off (the default) the button beside the message box is the flat circle the composer has always used. With it on, the same button is drawn as a clear glass bubble: a near-transparent dark body, a glowing meniscus round the rim, a bright crescent reflection hugging the upper-left edge, a crisp window streak just inside the upper-left rim that glides a few degrees round the edge, a thinner crescent on the right and a short exit arc on the lower-right, a small hard glint, a caustic on the lower-left inner wall, and a soft blue bloom around the outside. Inside it, frosted near-white chevrons frame one broad, pale-blue extruded folder with the `+N` / `−N` counts embossed directly into its face. The separate rectangular backing is transparent, matching the reference's clean folder silhouette. The pictogram stays front-on and pixel-aligned for clarity while highlights drift across the glass.

The option changes **how the button is painted, never what it does**. Same 44 × 44 tap target, same `aria-label`, same menu.

## Usage

1. Open **Settings → Chat defaults**.
2. Turn on **Glass orb file button**. The choice saves immediately and applies app-wide, so every project's composer uses it.
3. Open any chat. The button beside the text box is now the orb.

Turn it back off to return to the flat circle. Nothing else about the composer moves: the orb occupies the same 44 × 44 box in the composer row, so the text area and the send button do not shift.

| Setting | Off (default) | On |
|---------|---------------|-----|
| Painted circle | Flat `--surface-2` with a 1px border | Clear glass bubble: near-transparent dark body, a glowing meniscus rim, crescent reflections along the upper-left and right edges, a gliding window streak, a lower-right exit arc, a hard glint, a lower-left caustic and an outer blue bloom |
| Chevrons | One `currentColor` bar each | Frosted glass bars: a translucent near-white face over a pale-blue thickness, with a faint blue glow |
| Folder | One flat silhouette | One broad extruded silhouette: a 1px dark side, a near-white face with a cool hairline outline, ambient occlusion, and a rim light along its top edges |
| Tile | — | Transparent; retained only as the folder's 3D positioning layer so no second rectangular card shows |
| Counts | Flat colored glyphs at a fixed `0.46rem` | Raised 3D digits: a lit top-left rim, a stepped side wall in darker shades of the digit's own green/red extruding down-right, and a soft cast shadow on the folder face; corner-aligned and sized per render from the longest count drawn (8px down to 6px). Every depth step is in `em`, so it scales with the digits |
| Motion | None | Pictogram stays pixel-aligned; only the rim streak (a slow ±11° glide) and the folder highlight move |
| Tap target | `44 × 44` | `44 × 44` (unchanged) |
| `aria-label` | Exact counts in words | Exact counts in words (unchanged) |

### Reduced motion

With the operating system's *reduce motion* preference on, the orb still renders; its moving highlights hold a single frame. The pictogram itself is always front-on and pixel-aligned, so the chevrons, folder edge, and small counts remain crisp at the button's real size.
