# Draft Craft

## Overview

Draft Craft adds material to a chat draft without sending it: an annotated image, code selected in the file editor, or an Inspector log / network entry. The draft stays yours to review before you send.

![The Draft Craft annotator over an attached image](./images/draft-craft/annotator-canvas-360.png)

## Annotate an image

### From a chat attachment

![An attached image waiting in the composer](./images/draft-craft/composer-image-chip-360.png)

1. Attach an image to the composer — the **add image** button, paste, or drag — and tap its chip.
2. Mark it up. The controls are described under **In the annotator** below.
3. Tap **Use annotated image**: the annotated version replaces that attachment and its note is appended to the draft.

### From the Inspector

![The Draft Craft icon in the Preview toolbar](./images/draft-craft/inspector-preview-360.png)

1. Open **Inspector** and connect to a browser tab.
2. In the **Preview** toolbar, tap the blue image-and-sparkle **Draft Craft** icon, beside the other preview actions.
3. Mark up the page, then tap **Add to chat draft** and choose a project and chat.

![Choosing the project and chat for an annotated image](./images/draft-craft/add-to-draft-360.png)

### In the annotator

![Numbered dots and the scrollable list of dot texts](./images/draft-craft/annotator-marker-edit-360.png)

- **Tools** collapses the zoom, color and marker controls so the image gets the full canvas.
- **Fit** shows the whole picture; **−** / **+** change zoom and the pinch midpoint stays under your fingers; **Pan** moves a zoomed image.
- **Marker dots** lists one row per dot, scrolled inside the panel, so the tools panel keeps its height no matter how many dots you place. Each row holds the dot's label, a text field for that dot, and a delete button; tap a row's dot to select it, and a newly dragged dot scrolls its own row into view.
- **Reset** appears once the image has an annotation and restores the untouched original.
- An exported image that is too large is downscaled. An image that cannot be exported leaves the annotator open with an error instead of sending the message without it.

## Add an Inspector entry

The Inspector detail sheet's **Add to chat** button sends a tapped console log, exception, or network request to a draft. See [Add Inspector entries to a chat](inspector-add-to-chat.md) for the exact text it appends.

## Add selected file code

Draft Craft adds only the path with its line range and the selected code — no prose, no code fence.

![Draft Craft in the open file display bar](./images/draft-craft/file-editor-360.png)

1. Open a chat's file toolbar and choose **Files**.
2. Open a text file and select code in the editor.
3. Tap **Draft Craft** in the open file's display bar, beside the file actions.
4. Choose a project and chat, then tap **Add to draft**.

## Good to know

- Nothing is sent automatically: Draft Craft never starts a model run.
- Draft text and attachments you already have are preserved; Draft Craft only appends.
- A draft holds up to eight images in total, counted with the images you attached yourself.
