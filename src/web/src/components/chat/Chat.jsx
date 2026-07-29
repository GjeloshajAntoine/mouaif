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

export function ChatView(props) {
  const s = useChatState(props);
  const {
    refs,
    imageAttachments, fileEditorOpen, runningVisible,
    chatSwitcherOpen, chatSwitcherList,
    setFileEditorOpen,
    setChatSwitcherOpen,
    send, onPickerSearch,
    onRefreshAllProviders, onOpenModelPicker, onCloseModelPicker,
    onComposerKey, onComposerInput, onComposerPaste, onImagePickerChange,
    onRemoveImage, onJumpToBottom, onCancelRunning, onBack,
    onToggleChatSwitcher, onSwitchChat
  } = s;

  const { projectDir, chatId } = props;
  const [FileEditor, setFileEditor] = useState(null);

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
          'aria-label': 'Switch to a chat'
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
              h('span', { class: 'chat-view__chat-switcher-item-model' }, c.modelId || '')
            )
          ),
          !chatSwitcherList.length ? h('div', { class: 'chat-view__chat-switcher-empty' }, 'No other chats') : null
        ),
        h('div', { ref: refs.usageSummaryRef, class: 'chat-view__usage-summary', 'aria-label': 'Chat usage and provider credit' },
          h('span', null, 'Context --'),
          h('span', null, 'Total --')
        )
      ),
      h('div', { class: 'chat-view__model-row' },
        h('button', {
          ref: refs.modelPickerTrigger,
          class: 'chat-view__model-trigger',
          type: 'button',
          id: 'chatModelTrigger',
          onClick: onOpenModelPicker,
          'aria-label': 'Pick model',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false'
        },
          h('span', { class: 'chat-view__model-stack' },
            h('span', { class: 'chat-view__model-id' }, '(pick a model)'),
            h('span', { class: 'chat-view__model-provider' }, '')
          ),
          h('span', { class: 'chat-view__model-caret', 'aria-hidden': 'true' }, '▾')
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
        h('div', {
          ref: refs.modelPickerPop,
          class: 'chat-view__picker',
          hidden: true,
          role: 'dialog',
          'aria-label': 'Pick a model'
        },
          h('div', { class: 'chat-view__picker-head' },
            h('input', {
              ref: refs.modelPickerSearch,
              class: 'chat-view__picker-search',
              type: 'search',
              placeholder: 'Search models',
              'aria-label': 'Search models',
              onInput: onPickerSearch
            }),
            h('button', {
              ref: refs.modelPickerRefresh,
              class: 'chat-view__picker-refresh',
              type: 'button',
              onClick: onRefreshAllProviders,
              'aria-label': 'Refresh model lists',
              title: 'Refresh model lists from all providers'
            },
              h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
                h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
              )
            ),
            h('button', {
              class: 'chat-view__picker-close',
              type: 'button',
              onClick: onCloseModelPicker,
              'aria-label': 'Close',
              title: 'Close'
            }, '×')
          ),
          h('div', { class: 'chat-view__picker-chips', role: 'tablist', 'aria-label': 'Filter by provider' }),
          h('div', { ref: refs.modelPickerList, class: 'chat-view__picker-list' })
        )
      ),
      h('a', {
        class: 'chat-view__iconbtn',
        href: '#/settings/project?projectDir=' + encodeURIComponent(projectDir || '') + '&chatId=' + encodeURIComponent(chatId || ''),
        'aria-label': 'Project settings',
        title: 'Settings'
      },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
          h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })
        )
      ),
      h(ToolPopup, {
        tools: s.state.tools,
        mcpServers: s.state.mcpServers,
        usedTools: s.state.usedTools,
        agentFiles: s.state.agentFiles,
        skills: s.state.skills,
        toolAuth: s.state.toolAuth,
        onToggleTool: s.state._toggleTool,
        onToggleToolGroup: s.state._toggleToolGroup,
        onToggleMcpServer: s.state._toggleMcpServer,
        onToggleAgentFiles: s.state._toggleAgentFiles,
        onToggleSkills: s.state._toggleSkills,
        onSaveToolAuth: s.state._saveToolAuth
      })
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
    h('div', { class: 'chat-view__composer-row' },
      h('div', { class: 'chat-view__composer-tool' },
        h(FileToolbar, { projectDir, onOpenFileEditor: () => setFileEditorOpen(true) })
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
          : h('button', { ref: refs.sendBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: send, 'aria-label': 'Send' },
              h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
                h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
              )
            ),
        imageAttachments.length ? h('div', { class: 'chat-view__image-preview' },
          imageAttachments.map((a, idx) => h('button', { key: idx, class: 'chat-view__image-chip', type: 'button', onClick: () => onRemoveImage(idx), title: 'Remove image' },
            h('img', { src: a.dataUrl, alt: a.name || 'attached image' }),
            h('span', null, '×')
          ))
        ) : null
      )
    ),
    h('div', { class: 'chat-view__status-row' },
      h('span', { ref: refs.status, class: 'status chat-view__status', 'aria-live': 'polite' })
    ),
    fileEditorOpen && FileEditor
      ? h(FileEditor, { projectDir, onClose: () => setFileEditorOpen(false) })
      : null
  );
}
