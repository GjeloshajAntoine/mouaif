// mouaif web — Chat view (the main Preact component)
//
// Thin wrapper around useChatState. The heavy lifting — DOM
// construction, SSE handling, model picker, transcript rendering,
// tool cards, etc. — lives in the sibling chat/*.js modules. This
// file's only job is to wire props, return the JSX, and forward
// the action callbacks to the right elements.
import { h } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { useChatState } from './useChatState.js';
import { mountAtMention, refreshAtMentionItems } from './atMention.js';
import { FileToolbar } from './FileToolbar.jsx';
import { ToolPopup } from './ToolPopup.jsx';
import { ModelPickerField } from '../ModelPickerField.jsx';
import { WebpreviewDock } from './WebpreviewDock.jsx';
import { PreviewUrlPrompt } from './PreviewUrlPrompt.jsx';
import { authorizationCard } from './cards.js';
import { requestWebpreview, setStatus } from '../../api.js';
import { formatCost } from '../../usage.js';
import { subscribe as subscribeWebPreview, clearActive as clearWebPreview, getActivePayload, publish as publishWebPreview } from './webpreviewState.js';
import { teardownImageLightbox } from './toolRender.js';
import { saveComposerDraftNow } from './composer.js';
import { updateUsageSummary } from './usage.js';
import { attributedCostAfter } from './costSummary.js';
import { MicButton } from './MicButton.jsx';
import {
annotatedAttachment,
annotationReset,
annotationTextInsertion,
originalImageDataUrl,
removeAnnotationText,
shiftAnnotationStarts,
toPublicImageAttachments
} from './annotation.js';

export function ChatView(props) {
  const s = useChatState(props);
  const {
  refs,
  imageAttachments, composerText, fileEditorOpen, runningVisible, authStamp, toolDataStamp,
  mcpStartBusy, fileOrb, composerTools,
chatSwitcherOpen, chatSwitcherList, chatSwitcherLoading, customActions,
setFileEditorOpen,
    setImageAttachments,
    setComposerText,
    setChatSwitcherOpen,
    picker,
    send, onPickerPick, onPickerTogglePin, onPickerOpen, onRefreshAllProviders, onPickerOpenChange,
    onComposerKey, onComposerInput, onComposerPaste, onImagePickerChange,
    onRemoveImage, onJumpToBottom, onCancelRunning, onBack, onToggleAutoRetry,
onToggleChatSwitcher, onChatSwitcherScroll, onSwitchChat, runCustomAction, refreshCustomActions, updateChat
} = s;

  const { projectDir, chatId } = props;
// dictationCostRef — the running total of dictation runs attributed to this
// chat since the last authoritative cost snapshot, keyed by *which* snapshot it
// was accumulated against. A transcription is billed work that writes no
// message row (it lands in the composer draft), so the server adds it to the
// persisted chat and project totals and this ref keeps the header Total honest
// between that write and the next snapshot. The key is the snapshot object
// itself: a rebase (tail sync or reload) installs a fresh object that already
// covers every attributed run, so the accumulator starts from zero again
// instead of adding the earlier runs a second time.
const dictationCostRef = useRef(null);
const [FileEditor, setFileEditor] = useState(null);
// dictationTailRef — the live region of the composer, as the last dictation
// write left it: where it started and what it said. A second write for the
// *same* take (each chunk of a live transcript, then the finished one) replaces
// that region instead of appending again, so dictating while talking edits one
// growing tail rather than stacking transcript on transcript.
//
// Only a run that was handed a `live` flag participates: every other caller
// appends and clears the ref, which is exactly the old behaviour.
const dictationTailRef = useRef(null);
// onTranscript(text, meta) — append an inserted transcript to the in-progress
// composer draft, and report the run in the chat's status row.
//
// The transcript is appended, not merged by word, and the caret is placed
// after it: dictation is an input method, so the user's existing text is
// theirs and the next thing they type continues the dictation. Surrounding
// text is separated by a single space, never a newline — a transcript dropped
// mid-sentence must not break the paragraph.
//
// `meta.cost` is the server's priced result for the run. It goes on the status
// line so the user sees what dictating just cost at the moment it happened; a
// priced run is also attributed to this chat by the server (see
// dictationCostRef below), which is where the header Total picks it up. An
// unpriced run (`known: false` — a per-minute model reports no tokens) says
// nothing extra rather than `$0.00` — which is why a live chunk, whose price
// nobody knows until the take ends, passes `null`.
function onTranscript(text, meta) {
  const el = refs.promptInput.current;
  if (!el) return;
  // A live chunk that recognised nothing changes nothing: rewriting the draft
  // around an empty transcript would delete the tail that is already there.
  if (meta && meta.live && !String(text || '').trim()) return;
  const value = el.value;
  const remembered = dictationTailRef.current;
  const tail = (remembered && remembered.text) ? remembered : null;
  // Where this write lands. For a live take the answer owns the region the
  // previous answer wrote — found at the recorded offset, or wherever it moved
  // to if the user typed in front of it. When it cannot be found at all (the
  // user edited the tail by hand, or selected and deleted it) the write falls
  // back to the caret and appends, which is the honest reading of "the text I
  // was given is no longer here".
  let at = null;
  if (tail) {
    if (value.slice(tail.start, tail.start + tail.text.length) === tail.text) at = tail.start;
    else {
      const found = value.indexOf(tail.text);
      if (found >= 0) at = found;
    }
  }
  const owned = at !== null && tail ? tail.text.length : 0;
  if (at === null) at = (typeof el.selectionStart === 'number' ? el.selectionStart : value.length);
  const before = value.slice(0, at);
  const after = value.slice(at + owned);
  // Separate the transcript from surrounding text with a single space, not a
  // newline: a dictation dropped mid-sentence should not break the paragraph.
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tailSpace = after && !/^\s/.test(after) ? ' ' : '';
  const next = before + lead + text + tailSpace + after;
  // Remember the region this write owns while the run is live (a chunk), and
  // forget it for the finished hand-off.
  dictationTailRef.current = (meta && meta.live)
    ? { start: at, text: lead + text }
    : null;
  syncComposer(next);
  if (updateChat) {
    saveComposerDraftNow(next, refs, updateChat).catch(() => {});
  }
  // A priced, non-live run is attributed to this chat by the server (it wrote
  // the same number into the chat's persisted Total and the project total).
  // Fold it into the visible Total now, so the header agrees with the chat list
  // without waiting for a reload; the next cost snapshot rebases this away.
  const attributed = meta && !meta.live ? meta.cost : null;
  if (attributed && attributed.known && Number.isFinite(Number(attributed.total))) {
    const next = attributedCostAfter(dictationCostRef.current, s.state.costSnapshot, attributed.total);
    if (next) {
      dictationCostRef.current = next;
      s.state.attributedCost = next.total;
      updateUsageSummary(s.state, null, refs);
    }
  }
  const caret = (before + lead + text).length;
  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(caret, caret);
  } catch { /* a detached textarea cannot take a caret */ }
  // A live chunk is not a finished run: it must not claim a cost, and it must
  // not call the take "added" once per chunk while the user is still talking.
  // The button's own status row owns that narrative until the take settles.
  if (!meta || !meta.live) {
    // `setStatus` takes the ref, not the bag of them: passing `refs` made the
    // write a no-op (`ref.current` was undefined), which is why the chat's status
    // row never showed "dictation added" at all (docs/…/dictation.md promises it).
    setStatus(refs.status, 'dictation added' + dictationCostSuffix(meta), 'success');
  }
}

// dictationCostSuffix(meta) — " · $0.00012" when the run was priced, and
// nothing at all when it was not. The chat's status row is one short line under
// the composer, so an unpriced run must not spend it on `--`.
function dictationCostSuffix(meta) {
const cost = meta && meta.cost;
if (!cost || !cost.known || !isFinite(Number(cost.total))) return '';
return ' · ' + formatCost(cost.total);
}

// onMicStatus(message, state) — what the dictation button is doing, or why it
// stopped, written to the chat's own status row.
//
// The button cannot reach that row itself (`refs.status` belongs to this
// component) and its own report is a `title`, which no phone shows: a tap that
// found nothing configured recorded, stopped, and left the screen unchanged.
// Errors and progress now land here; the success hand-off keeps this row for
// itself (see onTranscript above), so the two never overwrite each other.
function onMicStatus(message, state) {
setStatus(refs.status, message, state);
}

// onMicProgress(message, state) — a live take's running total, written without
// moving the caret.
//
// The status element's text is set imperatively (`setStatus`), which Preact
// does not diff against, so a chunk's re-render leaves the note alone. That is
// the point: the draft write focuses the composer and puts the caret at the end
// of the transcript, and doing that twice per chunk (once for the draft, once
// for an unrelated node) is how a live take fights the user. The button's own
// tooltip is still updated, which is where the clock lives.
function onMicProgress(message, state) {
setStatus(refs.status, message, state);
}

// onDraftCraftAdded(result) — apply a Draft Craft hand-off to this chat's
// pending draft (text + image attachments). The status line is the chat's own,
// not the button's: the button reports what it did in its title.
function onDraftCraftAdded(result) {
if (!result || result.projectDir !== projectDir || result.chatId !== chatId || !result.chat) return;
const chat = result.chat;
if (refs.promptInput.current) {
refs.promptInput.current.value = chat.draft || '';
setComposerText(chat.draft || '');
if (refs._autoresize) refs._autoresize();
}
setImageAttachments(Array.isArray(chat.draftAttachments) ? chat.draftAttachments : []);
}
// Reusable image annotator for the composer: tapping an attached image
// chip opens the Draft Craft annotator, and the annotated image replaces
// that attachment in-place. `annotateTarget` is { index, attachment } or
// null. The original dataUrl is kept on the annotator so "Reset" can
// restore it from inside the popup.
const [annotateTarget, setAnnotateTarget] = useState(null);
function syncComposer(value) {
if (refs.promptInput.current) refs.promptInput.current.value = value;
setComposerText(value);
if (refs._autoresize) refs._autoresize();
}
function onAnnotated(payload) {
if (!annotateTarget || !payload || !payload.image) return;
const next = (Array.isArray(imageAttachments) ? imageAttachments.slice() : []);
const original = next[annotateTarget.index];
if (original) {
const annotationText = (typeof payload.text === 'string' ? payload.text : '').trim();
const previousAnnotation = annotationReset(original);
const currentText = refs.promptInput.current ? refs.promptInput.current.value : composerText;
const withoutPrevious = previousAnnotation
? removeAnnotationText(currentText, previousAnnotation.annotationText, previousAnnotation.annotationStart)
: currentText;
const insertion = annotationTextInsertion(withoutPrevious, annotationText);
const removedChars = currentText.length - withoutPrevious.length;
const shifted = previousAnnotation && removedChars
? shiftAnnotationStarts(next, previousAnnotation.annotationStart, -removedChars, annotateTarget.index)
: next;
shifted[annotateTarget.index] = annotatedAttachment(original, payload.image, annotationText, insertion.start);
const nextText = insertion.value;
setImageAttachments(shifted);
syncComposer(nextText);
if (updateChat) {
saveComposerDraftNow(nextText, refs, updateChat, {
draftAttachments: toPublicImageAttachments(shifted)
}).catch(() => {});
}
}
setAnnotateTarget(null);
}
function onAnnotatorReset() {
if (!annotateTarget) return;
const next = Array.isArray(imageAttachments) ? imageAttachments.slice() : [];
const reset = annotationReset(next[annotateTarget.index]);
if (!reset) return;
const currentText = refs.promptInput.current ? refs.promptInput.current.value : composerText;
const nextText = removeAnnotationText(currentText, reset.annotationText, reset.annotationStart);
const removedChars = currentText.length - nextText.length;
const shifted = removedChars
? shiftAnnotationStarts(next, reset.annotationStart, -removedChars, annotateTarget.index)
: next;
shifted[annotateTarget.index] = reset.attachment;
setImageAttachments(shifted);
syncComposer(nextText);
if (updateChat) {
saveComposerDraftNow(nextText, refs, updateChat, {
draftAttachments: toPublicImageAttachments(shifted)
}).catch(() => {});
}
}
// The latest webpreview capture lives in a fixed dock above the composer.
// The full-screen viewer is a separate local toggle so dismissing the viewer
// leaves the small user-facing preview available.
const [webPreviewPayload, setWebPreviewPayload] = useState(() => getActivePayload());
const [webPreviewOpen, setWebPreviewOpen] = useState(false);
// PreviewUrlPrompt — the "Preview" entry in the FileToolbar asks for a URL
// and runs a fresh web-preview capture directly (no model round-trip).
const [previewPromptOpen, setPreviewPromptOpen] = useState(false);

  // The web-preview viewer and the image annotator only open on a tap, so
  // they load on first use instead of riding the chat view's entry bundle.
  const WebpreviewModal = useLazyView(webPreviewOpen && !!webPreviewPayload, () => import('./WebpreviewModal.jsx'), 'WebpreviewModal');
  const DraftCraftAnnotator = useLazyView(!!annotateTarget, () => import('../inspector/DraftCraftAnnotator.jsx'), 'DraftCraftAnnotator');

  useEffect(() => {
    if (!fileEditorOpen || FileEditor) return;
    let cancelled = false;
    import('../FileEditor.jsx').then((mod) => {
      if (!cancelled) setFileEditor(() => mod.FileEditorView);
    }).catch(() => {
      if (!cancelled) setFileEditor(null);
    });
    return () => { cancelled = true; };
  }, [fileEditorOpen, FileEditor]);

// Subscribe to captures published by the imperative tool renderer. A new
// capture replaces the dock image but never opens the full viewer without a
// user tap. Clear it when switching chats so previews cannot leak across chats.
useEffect(() => {
const off = subscribeWebPreview((payload) => {
setWebPreviewPayload(payload || null);
if (!payload) setWebPreviewOpen(false);
});
setWebPreviewPayload(getActivePayload());
return () => { off(); };
}, []);
useEffect(() => {
clearWebPreview();
setWebPreviewPayload(null);
setWebPreviewOpen(false);
setPreviewPromptOpen(false);
}, [projectDir, chatId]);

  useEffect(() => {
    // The tool-card image viewer is mounted at the document root, outside this
    // component, so nothing else removes it. Leaving the chat with it open
    // would park a full-screen overlay over the next screen and leak its
    // keydown listener; drop it with the view.
    return () => { teardownImageLightbox(); };
  }, []);

  const atMentionRef = useRef(null);
  const atArgBarRef = useRef(null);
  useEffect(() => {
    // Mount the at-mention popup on the composer textarea
    if (!refs.promptInput.current || !atMentionRef.current) return;
    const cleanup = mountAtMention(
      refs.promptInput.current,
      atMentionRef.current,
      s.state,
      atArgBarRef.current
    );
    // Refresh items periodically so new files / tools show up
    const timer = setInterval(() => refreshAtMentionItems(), 5000);
    return () => {
      cleanup();
      clearInterval(timer);
    };
  }, [refs.promptInput, refs.promptInput.current, s.state.props && s.state.props.projectDir]);

  return h('section', { class: 'chat-view' },
    h('div', { class: 'chat-view__head' },
      h('button', { ref: refs.back, class: 'chat-view__back', type: 'button', onClick: onBack, 'aria-label': 'Back to projects' }, '←'),
      h('div', { class: 'chat-view__title-stack', 'data-switcher': '1' },
        h('button', {
          ref: refs.chatSwitcherTrigger,
          class: 'chat-view__chat-switcher-trigger',
          type: 'button',
          onClick: onToggleChatSwitcher,
          'aria-label': 'Switch chat',
          'aria-haspopup': 'true',
          'aria-expanded': String(chatSwitcherOpen)
        },
          h('div', { class: 'chat-view__chat-switcher-title' },
            h('div', { ref: refs.chatName, class: 'chat-view__name' }, '…'),
            h('div', { ref: refs.chatMeta, class: 'chat-view__meta' }, '')
          ),
          h('span', { class: 'chat-view__chat-switcher-caret', 'aria-hidden': 'true' }, '▾')
        ),
        h('div', {
          ref: refs.chatSwitcherPop,
          class: 'chat-view__chat-switcher-pop',
          hidden: !chatSwitcherOpen,
          role: 'listbox',
          'aria-label': 'Switch to a chat',
          onScroll: onChatSwitcherScroll,
        },
          chatSwitcherList.map((c) =>
            h('button', {
              key: c.id,
              class: 'chat-view__chat-switcher-item' + (c.id === chatId ? ' is-current' : ''),
              type: 'button',
              role: 'option',
              'aria-selected': String(c.id === chatId),
              onClick: () => onSwitchChat(c.id)
            },
              h('span', { class: 'chat-view__chat-switcher-item-title' }, (c.title && c.title.trim()) ? c.title : 'New chat'),
              h('span', { class: 'chat-view__chat-switcher-item-model' }, c.modelId || ''),
              c.id === chatId && runningVisible
                ? h('span', { class: 'chat-view__chat-switcher-running', 'aria-hidden': 'true' })
                : null
            )
          ),
          !chatSwitcherList.length ? h('div', { class: 'chat-view__chat-switcher-empty' }, 'No other chats') : null,
          h('div', {
            class: 'chat-view__chat-switcher-more',
            hidden: !chatSwitcherLoading
          }, 'Loading more…')
        ),
        h('div', { ref: refs.usageSummaryRef, class: 'chat-view__usage-summary', 'aria-label': 'Chat usage and provider credit' },
          h('span', null, 'Context --'),
          h('span', null, 'Total --')
        )
      ),
      h('div', { class: 'chat-view__model-row' },
        h(ModelPickerField, {
          models: picker.models,
          value: picker.value,
          variant: 'chat',
          open: picker.open,
          onOpenChange: onPickerOpenChange,
          noProviders: !s.state.providers.length,
          pinned: picker.pinned,
          onTogglePin: onPickerTogglePin,
          recent: picker.recent,
          extraProviders: picker.providers,
          refresh: onRefreshAllProviders,
          refreshEmpty: 'Refresh models',
          ariaLabel: 'Pick model',
          onOpen: onPickerOpen,
          onChange: onPickerPick
        },
        h('div', { class: 'chat-view__picker-maxout' },
          h('input', {
            ref: refs.maxOutputTokens,
            class: 'input chat-view__picker-maxout-input',
            type: 'number',
            min: 1,
            inputMode: 'numeric',
            placeholder: 'Max output tokens (blank = default)',
            'aria-label': 'Max output tokens',
            onBlur: (e) => {
              const v = e.currentTarget.value.trim();
              if (v && s.state.chat) {
                s.state.maxOutputTokens = v;
                if (v !== (s.state.chat.maxOutputTokens || '')) {
                  s.updateChat({ maxOutputTokens: v });
                }
              } else if (!v && s.state.chat && s.state.chat.maxOutputTokens) {
                s.state.maxOutputTokens = '';
                s.updateChat({ maxOutputTokens: '' });
              }
            },
            onKeydown: (e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }
          })
        )
      ),
      h('select', {
        ref: refs.thinkingLevel,
          class: 'input chat-view__thinking-select',
          'aria-label': 'Thinking level',
          'data-allow-custom': '1',
          onChange: (e) => {
            const v = e.currentTarget.value;
            s.state.thinkingLevel = v;
            // Show/hide the custom input
            const customInput = s.refs.thinkingLevelCustom && s.refs.thinkingLevelCustom.current;
            if (customInput) {
              customInput.hidden = v !== '__custom__';
              if (v === '__custom__') customInput.focus();
            }
            if (v !== '__custom__' && s.state.chat) {
              s.updateChat({ thinkingLevel: v });
            }
          }
        }),
        h('input', {
          ref: refs.thinkingLevelCustom,
          class: 'input chat-view__thinking-custom',
          type: 'text',
          hidden: true,
          placeholder: 'e.g. 4096, minimal, low, high',
          'aria-label': 'Custom thinking level',
          onBlur: (e) => {
            const v = e.currentTarget.value.trim();
            if (v && s.state.chat) {
              s.state.thinkingLevel = v;
              s.updateChat({ thinkingLevel: v });
            }
          },
          onKeydown: (e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }
        }),
      ),
      h('div', { class: 'chat-view__head-icons' },
          h('a', {
            class: 'chat-view__iconbtn',
            href: '#/settings/project?projectDir=' + encodeURIComponent(projectDir || '') + '&chatId=' + encodeURIComponent(chatId || ''),
            'aria-label': 'Project settings',
            title: 'Settings'
          },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': 'true' },
              h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })
            )
          ),
          h(ToolPopup, {
            tools: s.state.tools,
            mcpServers: s.state.mcpServers,
usedTools: s.state.usedTools,
agentFiles: s.state.agentFiles,
skills: s.state.skills,
autoRetry: s.state.autoRetry,
onToggleAutoRetry,
toolAuth: s.state.toolAuth,
mcpAuth: s.state.mcpAuth,
onToggleTool: s.state._toggleTool,
            onToggleToolGroup: s.state._toggleToolGroup,
            onToggleAgentFiles: s.state._toggleAgentFiles,
            onToggleSkills: s.state._toggleSkills,
            onToggleSkill: s.state._toggleSkill,
            onSaveToolAuth: s.state._saveToolAuth,
            onSaveMcpAuth: s.state._saveMcpAuth,
            // Start a stopped-but-enabled MCP server from the tree's "…"
            // control. The popup rendered ToolTree without this handler,
            // so its control was inert (the transcript card's twin worked).
            onReloadMcpServer: s.state._startMcpServer,
            mcpStartBusy,
            // Last start failure per server id, shown under the row.
            mcpStartErrors: s.state._mcpStartErrors,
            // Render stamps keep ref-backed authorization and catalog data fresh.
            authStamp,
            toolDataStamp
          })
        )
    ),
h('div', { ref: refs.transcript, class: 'chat-view__transcript', 'aria-live': 'polite' }),
h('button', {
ref: refs.jumpBtn,
      class: 'chat-view__jump',
      type: 'button',
      hidden: true,
      onClick: onJumpToBottom,
      'aria-label': 'Jump to latest messages'
    },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', { d: 'M12 16.5 4.5 9l1.4-1.4 6.1 6.1 6.1-6.1L19.5 9 12 16.5Z', fill: 'currentColor' })
      ),
h('span', { class: 'chat-view__jump-count' }, '')
),
h(WebpreviewDock, {
preview: webPreviewPayload,
onOpen: () => setWebPreviewOpen(true),
onDismiss: () => clearWebPreview()
}),
h('div', { class: 'chat-view__composer-row' },
h('div', { class: 'chat-view__composer-tool' },
h(FileToolbar, {
projectDir,
orb: fileOrb,
onOpenFileEditor: () => setFileEditorOpen(true),
onOpenPreview: () => setPreviewPromptOpen(true),
customActions,
onRunCustomAction: runCustomAction,
onRefreshCustomActions: refreshCustomActions
})
),
      h('div', { class: 'chat-view__composer' },
        h('div', { ref: atMentionRef, class: 'at-mention', role: 'listbox', 'aria-label': 'Suggestions', hidden: true }),
        h('div', { ref: atArgBarRef, class: 'at-mention__arg-bar', hidden: true }),
        composerTools.image
        ? h('button', { class: 'chat-view__iconbtn chat-view__image-btn', type: 'button', onClick: () => refs.imageInput.current && refs.imageInput.current.click(), 'aria-label': 'Add image', title: 'Add image' },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 13.5L9.5 13l3 3 2-2.5 4.5 4.5V6H5v11.5ZM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', fill: 'currentColor' })
        )
        )
        : null,
        // The file input is mounted either way. It is the path a pasted image
        // (and the annotation editor's own capture) travels, so hiding the
        // button removes a control, never a capability.
        h('input', { ref: refs.imageInput, class: 'chat-view__image-input', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, onChange: onImagePickerChange }),
        // Both of these are optional composer tools (Settings → Chat defaults,
        // see docs/features/composer-tool-buttons.md). The mic is off for a
        // user who never dictates, the image button for one who never attaches
        // a picture — and each is *hidden*, not disabled: nothing else about
        // the composer changes.
        composerTools.dictation
        ? h(MicButton, { projectDir, chatId, promptRef: refs.promptInput, onTranscript, onStatus: onMicStatus, onProgress: onMicProgress })
        : null,
        h('textarea', { ref: refs.promptInput, class: 'input chat-view__textarea', id: 'chatComposer', rows: 1, placeholder: imageAttachments.length ? 'Add a caption or send' : 'Type a message', 'aria-label': 'Message', onKeydown: onComposerKey, onPaste: onComposerPaste, onInput: onComposerInput }),
        runningVisible
          ? h('button', { ref: refs.stopBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: onCancelRunning, 'aria-label': 'Stop' },
              h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
                h('path', { d: 'M6 6h12v12H6Z', fill: 'currentColor' })
              )
            )
          : h('button', { ref: refs.sendBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: send, disabled: !composerText.trim() && !imageAttachments.length, 'aria-label': 'Send' },
              h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
                h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
              )
            ),
imageAttachments.length ? h('div', { class: 'chat-view__image-preview' },
imageAttachments.map((a, idx) => h('div', { key: idx, class: 'chat-view__image-chip' },
h('button', { class: 'chat-view__image-chipimg', type: 'button', onClick: () => setAnnotateTarget({ index: idx, attachment: a }), 'aria-label': 'Annotate image ' + (a.name || (idx + 1)), title: 'Annotate image' },
h('img', { src: a.dataUrl, alt: a.name || 'attached image' })
),
h('button', { class: 'chat-view__image-chipremove', type: 'button', onClick: () => onRemoveImage(idx), title: 'Remove image', 'aria-label': 'Remove image ' + (a.name || (idx + 1)) },
h('span', null, '×')
)
))
) : null
)
),
// The status span stays mounted when the line is hidden (Settings → Chat
// defaults): a dozen modules write to `refs.status`. The CSS modifier hides
// the text but keeps the safe-area inset and any error state.
h('div', { class: 'chat-view__status-row' + (composerTools.status ? '' : ' chat-view__status-row--hidden') },
      h('span', { ref: refs.status, class: 'status chat-view__status', 'aria-live': 'polite' })
    ),
fileEditorOpen && FileEditor
? h(FileEditor, { projectDir, onClose: () => setFileEditorOpen(false), onDraftCraftAdded })
: null,
webPreviewOpen && webPreviewPayload && WebpreviewModal
? h(WebpreviewModal, {
preview: webPreviewPayload,
onClose: () => setWebPreviewOpen(false),
onRecapture: (viewport) => recaptureWebPreview(webPreviewPayload, viewport, {
projectDir,
chatId,
refs,
onAuthorizationRequired: () => setWebPreviewOpen(false)
})
})
: null,
previewPromptOpen
? h(PreviewUrlPrompt, {
onSubmit: (url) => runPreviewFromPrompt(url, { projectDir, chatId, refs, onPromptClose: () => setPreviewPromptOpen(false) }),
onClose: () => setPreviewPromptOpen(false)
})
: null,
annotateTarget && DraftCraftAnnotator
? h(DraftCraftAnnotator, {
image: annotateTarget.attachment,
originalDataUrl: originalImageDataUrl(annotateTarget.attachment),
sourceLabel: 'Attached image',
actionLabel: 'Use annotated image',
onReset: onAnnotatorReset,
onAnnotated,
onClose: () => setAnnotateTarget(null)
})
: null
);
}
// useLazyView — resolve a named export from a dynamic import the first time
// `wanted` turns true, then keep it. Returns null until the chunk has loaded.
function useLazyView(wanted, loader, name) {
  const [View, setView] = useState(null);
  useEffect(() => {
    if (!wanted || View) return undefined;
    let cancelled = false;
    loader().then((mod) => { if (!cancelled) setView(() => mod[name]); }).catch(() => {});
    return () => { cancelled = true; };
  }, [wanted, View]);
  return View;
}
// recaptureWebPreview — user-initiated re-capture of the web preview at a
// chosen resolution. Uses the direct /api/tools/webpreview endpoint (NOT a
// model round-trip) so the user sees the new screenshot immediately, then
// publishes it into the dock. `viewport` is a preset id or a 'WIDTHxHEIGHT'
// string; when the webpreview tool is disabled the endpoint returns 403 and
// we surface a hint on the status line rather than silently failing. In
// Ask mode, mount the standard authorization card and retry with the same
// call ID so an approved size change actually reaches the capture runner.
async function recaptureWebPreview(payload, viewport, ctx) {
const url = payload && payload.url;
if (!url) return null;
const projectDir = ctx && ctx.projectDir;
const chatId = ctx && ctx.chatId;
const refs = ctx && ctx.refs;
if (!projectDir || !chatId) return null;
const callId = 'ui_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const request = () => requestWebpreview({
projectDir,
chatId,
url,
viewport: viewport || undefined,
callId
});
let out = null;
try {
out = await request();
} catch (e) {
if (e && e.code === 'EAUTH_REQUIRED') {
if (ctx && typeof ctx.onAuthorizationRequired === 'function') ctx.onAuthorizationRequired();
let resumed = null;
const decision = await authorizationCard({
callId: e.callId || callId,
tool: 'webpreview',
cmd: url,
projectDir
}, projectDir, chatId, refs, async () => { resumed = await request(); });
if (decision !== 'deny') out = resumed;
} else {
const msg = (e && e.message) || String(e);
const statusRef = refs && refs.status;
if (statusRef && statusRef.current) statusRef.current.textContent = 'Preview recapture failed: ' + msg;
return null;
}
}
// Publish the fresh result so the dock updates in place.
if (out && out.ok && out.result && out.result.thumbnail) {
publishWebPreview(out.result);
} else if (out && !out.ok && refs && refs.status && refs.status.current) {
refs.status.current.textContent = 'Preview recapture failed: ' + ((out.result && out.result.error) || out.error || 'capture failed');
}
return out;
}
// runPreviewFromPrompt — capture a preview for a URL typed into the
// PreviewUrlPrompt. Uses the same direct /api/tools/webpreview path as
// recaptureWebPreview (no model round-trip). On success it publishes the
// screenshot to the dock and opens the full-screen viewer; on failure it
// surfaces the error on the status line. Closes the prompt either way.
async function runPreviewFromPrompt(url, ctx) {
const projectDir = ctx && ctx.projectDir;
const chatId = ctx && ctx.chatId;
const refs = ctx && ctx.refs;
const onPromptClose = ctx && ctx.onPromptClose;
if (!projectDir || !chatId) return null;
const callId = 'ui_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const verbose = refs && refs.status && refs.status.current;
if (verbose) verbose.textContent = 'Capturing preview…';
let out = null;
try {
out = await requestWebpreview({ projectDir, chatId, url, callId });
} catch (e) {
if (e && e.code === 'EAUTH_REQUIRED') {
// Ask gate: close the prompt, show the authorization card, resume.
if (onPromptClose) onPromptClose();
const decision = await authorizationCard({
callId: e.callId || callId,
tool: 'webpreview',
cmd: url,
projectDir
}, projectDir, chatId, refs, async () => {
out = await requestWebpreview({ projectDir, chatId, url, callId });
});
// Approval resumes the builder; a denial leaves the prompt closed.
if (decision !== 'deny') {
if (out && out.ok && out.result && out.result.thumbnail) publishWebPreview(out.result);
return out ? 'captured' : 'denied';
}
return 'denied';
}
const msg = (e && e.message) || String(e);
if (verbose) verbose.textContent = 'Preview failed: ' + msg;
return null;
}
if (onPromptClose) onPromptClose();
if (out && out.ok && out.result && out.result.thumbnail) {
publishWebPreview(out.result);
if (verbose) verbose.textContent = '';
return 'captured';
}
if (verbose) {
verbose.textContent = 'Preview failed: ' + ((out && out.result && out.result.error) || (out && out.error) || 'capture failed');
}
return null;
}
