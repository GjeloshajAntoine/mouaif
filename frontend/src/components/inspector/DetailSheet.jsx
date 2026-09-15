// Inspector DetailSheet — bottom-sheet detail for a tapped row
import { h, Fragment } from 'preact';
import { fmtTime, fmtBytes, fmtDur, statusLabel } from './format.js';
import { sheetPortal } from './sheetPortal.js';

export function DetailSheet(props) {
  const item = props.item;
  if (!item) return null;
  const isNet = item.kind === 'request';
  // "Add to chat" is offered whenever the Inspector can route the entry to a
  // draft — the parent supplies onAddToChat only when the app has a chat
  // surface to hand it to, and a text-less entry would append nothing, so
  // both gates show up as a disabled button rather than a hidden one.
  const canAddToChat = typeof props.onAddToChat === 'function';
  const addDisabled = !canAddToChat || !!props.addToChatDisabled;
  const addLabel = props.addToChatLabel || 'Add to chat';

  function kv(list) {
    return h('dl', { class: 'inspector__kv' }, list.map(([k, v]) =>
      h(Fragment, { key: k },
        h('dt', null, k),
        h('dd', null, v === undefined || v === null || v === '' ? '—' : String(v))
      )
    ));
  }

  function headersBlock(title, obj) {
    if (!obj || !Object.keys(obj).length) return null;
    return h(Fragment, null,
      h('h3', { class: 'inspector__sheet-h' }, title),
      h('pre', { class: 'inspector__headers' }, Object.keys(obj).map((k) => k + ': ' + obj[k]).join('\n'))
    );
  }

  return sheetPortal(h('div', { class: 'inspector__overlay', onClick: props.onClose },
    h('div', { class: 'inspector__sheet', role: 'dialog', 'aria-label': 'Details', onClick: (e) => e.stopPropagation() },
      h('div', { class: 'inspector__sheet-head' },
      h('strong', { class: 'inspector__sheet-title' }, isNet ? (item.method + ' ' + statusLabel(item.status)) : (item.level || 'log').toUpperCase()),
      h('div', { class: 'inspector__sheet-head-actions' },
      // Add to chat — hand this entry to a chat draft. Sits in the sheet
      // head next to Close so it is reachable without scrolling: the body
      // of a long stack trace / response body scrolls under it.
      h('button', {
        class: 'btn btn--primary inspector__sheet-add-chat',
        type: 'button',
        disabled: addDisabled,
        title: canAddToChat ? 'Add this entry to a chat draft' : 'Chats are unavailable',
        onClick: (e) => { e.stopPropagation(); if (canAddToChat) props.onAddToChat(); }
      }, addLabel),
      h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: props.onClose }, 'Close')
      )
      ),
      // Inner scroll wrapper. The sheet itself is overflow:hidden + max-height:80dvh;
      // without this flex child the kv list / headers / response body grew past the
      // sheet and any swipe scrolled the page underneath instead of the sheet.
      h('div', { class: 'inspector__sheet-body' },
        isNet
          ? h(Fragment, null,
              kv([
                ['URL', item.url],
                ['Type', item.type],
                ['MIME', item.mimeType],
                ['Size', fmtBytes(item.size)],
                ['Encoded', fmtBytes(item.encodedSize)],
                ['Duration', fmtDur(item.duration)],
                ['Remote', item.ip ? item.ip + (item.port ? ':' + item.port : '') : ''],
                ['Protocol', item.protocol],
                ['From cache', item.fromCache ? 'yes' : 'no'],
                ['Error', item.statusText]
              ]),
              headersBlock('Request headers', item.requestHeaders),
              headersBlock('Response headers', item.responseHeaders),
              h('h3', { class: 'inspector__sheet-h' }, 'Response body'),
              h('pre', { class: 'inspector__body' }, item.bodyLoading ? 'loading…' : (item.body !== undefined && item.body !== null && item.body !== '' ? item.body : '(no body captured)')),
              h('button', { class: 'btn', type: 'button', onClick: props.onLoadBody }, 'Fetch body')
            )
          : h(Fragment, null,
              kv([
                ['Time', fmtTime(item.ts)],
                ['Level', item.level],
                ['Source', item.url ? item.url + (item.line ? ':' + item.line : '') : '']
              ]),
              h('h3', { class: 'inspector__sheet-h' }, 'Message'),
              h('pre', { class: 'inspector__body' }, item.text || ''),
              item.stack ? h(Fragment, null,
                h('h3', { class: 'inspector__sheet-h' }, 'Stack trace'),
                h('pre', { class: 'inspector__body' }, item.stack)
              ) : null
            )
      )
    )
  ));
}
