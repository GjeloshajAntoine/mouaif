# Composer tool buttons

## Overview

Settings → App defaults → Chat defaults has three switches that decide which optional parts the chat composer draws: **Dictation microphone in the composer**, **Image button in the composer** and **Status line under the composer**. All are on by default. Turning one off removes that button from the composer row — for a user who never dictates, or never attaches a picture, and who does not want to reach past a control that does nothing for them every time they send a message.

Hiding is **not** disabling. The routes behind the buttons stay exactly as they were, so a hidden control removes a way to *reach* a capability, never the capability:

| Hidden | Still works |
|--------|-------------|
| Dictation microphone | The `#/dictation` page (record, transcribe, edit, copy / insert / send), the app-level dictation model choice, and `POST /api/ai/transcribe` |
| Image button | Pasting an image into the composer, the annotation editor, and image attachments on a send |
| Status line | Errors (a failed send, a refused key, a dictation with no model) still appear on the line; the home-indicator inset below the composer is kept |

## Usage

1. Open **Settings → App defaults** (the **Chat defaults** group).
2. Find the row you want and flip its switch:
   - **Dictation microphone in the composer** — off removes the microphone from the composer row.
   - **Image button in the composer** — off removes the picture-attachment button.
   - **Status line under the composer** — off hides the one-line status text below the message box ("streaming…", the turn cost, "dictation added"). Error messages still show.
3. Each row saves immediately (there is no Save button) and the choice applies app-wide, so every project's composer obeys it. The status line under the row confirms what happened.

Open any chat to see the result. The composer keeps the text area and the send button, so hiding both optional buttons leaves a narrower row rather than an empty one.

Turn a switch back on and the button returns — including in a chat that is already open, because the chat re-reads the app settings when its data loads.

### What does not change

- **The tap target.** An optional button is either drawn exactly as it was (44 × 44, its usual margin) or not drawn at all. Nothing is squeezed to make room.
- **The keyboard.** Enter / Shift+Enter behaviour is `enterForNewline` and is untouched.
- **The draft.** Whatever is already typed, and any attachment already made, stays put.

