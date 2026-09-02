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
import { WebpreviewModal } from './WebpreviewModal.jsx';
import { PreviewUrlPrompt } from './PreviewUrlPrompt.jsx';
import { authorizationCard } from './cards.js';
import { requestWebpreview } from '../../api.js';
import { subscribe as subscribeWebPreview, clearActive as clearWebPreview, getActivePayload, publish as publishWebPreview } from './webpreviewState.js';
import { DraftCraftAnnotator } from '../inspector/DraftCraftAnnotator.jsx';

export function ChatView(props) {
  const s = useChatState(props);
  const {
    refs,
    imageAttachments, composerText, fileEditorOpen, runningVisible, authStamp, toolDataStamp,
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
const [FileEditor, setFileEditor] = useState(null);
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
function onAnnotated(payload) {
if (!annotateTarget || !payload || !payload.image) return;
const next = (Array.isArray(imageAttachments) ? imageAttachments.slice() : []);
const original = next[annotateTarget.index];
if (original) {
// Keep the original dataUrl / name / mimeType so the annotator can
// reset back to the untouched image.
const hasOriginal = typeof original.__originalDataUrl !== 'undefined';
next[annotateTarget.index] = Object.assign({}, original, {
dataUrl: payload.image.dataUrl,
mimeType: payload.image.mimeType || original.mimeType,
name: payload.image.name || original.name
});
if (hasOriginal) {
// Preserve the first original and drop any nested original (the
// first annotate only seeds it; later annotates keep the first).
next[annotateTarget.index].__originalDataUrl = original.__originalDataUrl;
next[annotateTarget.index].__originalName = original.__originalName;
next[annotateTarget.index].__originalMimeType = original.__originalMimeType;
} else {
next[annotateTarget.index].__originalDataUrl = original.dataUrl;
next[annotateTarget.index].__originalName = original.name;
next[annotateTarget.index].__originalMimeType = original.mimeType;
}
setImageAttachments(next);
// Persist a clean copy (drop the client-only reset markers) so the
// chat draft never stores a duplicate of the original data URL.
const persist = next.map((a) => {
const clean = Object.assign({}, a);
delete clean.__originalDataUrl;
delete clean.__originalName;
delete clean.__originalMimeType;
return clean;
});
if (updateChat) updateChat({ draftAttachments: persist }).catch(() => {});
// Put the annotation context text into the composer so the note and
// marker list are visible before sending.
const text = (typeof payload.text === 'string' ? payload.text : '').trim();
if (text) {
if (refs.promptInput.current) refs.promptInput.current.value = text;
setComposerText(text);
if (refs._autoresize) refs._autoresize();
}
}
setAnnotateTarget(null);
}
function onAnnotatorReset() {
if (!annotateTarget) return;
const prev = Array.isArray(imageAttachments) ? imageAttachments : [];
const next = prev.slice();
const item = next[annotateTarget.index];
if (item && item.__originalDataUrl) {
next[annotateTarget.index] = Object.assign({}, item, {
dataUrl: item.__originalDataUrl,
name: item.__originalName !== undefined ? item.__originalName : item.name,
mimeType: item.__originalMimeType !== undefined ? item.__originalMimeType : item.mimeType
});
delete next[annotateTarget.index].__originalDataUrl;
delete next[annotateTarget.index].__originalName;
delete next[annotateTarget.index].__originalMimeType;
setImageAttachments(next);
if (updateChat) updateChat({ draftAttachments: next }).catch(() => {});
}
// Reverting to the original image also drops the annotation note that
// was written into the composer, so the textbox goes back to its prior
// draft (the composer draft still holds it on the chat record).
if (refs.promptInput.current) refs.promptInput.current.value = '';
setComposerText('');
if (refs._autoresize) refs._autoresize();
}
// The latest webpreview capture lives in a fixed dock above the composer.
// The full-screen viewer is a separate local toggle so dismissing the viewer
// leaves the small user-facing preview available.
const [webPreviewPayload, setWebPreviewPayload] = useState(() => getActivePayload());
const [webPreviewOpen, setWebPreviewOpen] = useState(false);
// PreviewUrlPrompt — the "Preview" entry in the FileToolbar asks for a URL
// and runs a fresh web-preview capture directly (no model round-trip).
const [previewPromptOpen, setPreviewPromptOpen] = useState(false);

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
            onSaveToolAuth: s.state._saveToolAuth,
            onSaveMcpAuth: s.state._saveMcpAuth,
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
        h('button', { class: 'chat-view__iconbtn chat-view__image-btn', type: 'button', onClick: () => refs.imageInput.current && refs.imageInput.current.click(), 'aria-label': 'Add image', title: 'Add image' },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 13.5L9.5 13l3 3 2-2.5 4.5 4.5V6H5v11.5ZM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', fill: 'currentColor' })
          )
        ),
        h('input', { ref: refs.imageInput, class: 'chat-view__image-input', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, onChange: onImagePickerChange }),
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
h('div', { class: 'chat-view__status-row' },
      h('span', { ref: refs.status, class: 'status chat-view__status', 'aria-live': 'polite' })
    ),
fileEditorOpen && FileEditor
? h(FileEditor, { projectDir, onClose: () => setFileEditorOpen(false), onDraftCraftAdded })
: null,
webPreviewOpen && webPreviewPayload
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
annotateTarget
? h(DraftCraftAnnotator, {
image: annotateTarget.attachment,
originalDataUrl: annotateTarget.attachment && annotateTarget.attachment.__originalDataUrl,
sourceLabel: 'Attached image',
actionLabel: 'Use annotated image',
onReset: onAnnotatorReset,
onAnnotated,
onClose: () => setAnnotateTarget(null)
})
: null
);
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
