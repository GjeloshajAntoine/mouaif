'use strict';

// Explicit references to images already stored in the current chat. Never
// scan or transfer the whole transcript, and never accept base64 tool args.
const { createHash } = require('node:crypto');
const chats = require('./chats.js');
const messages = require('./messages.js');
const { err } = require('./util.js');

function draftImageRef(attachment) {
  const digest = createHash('sha256').update(JSON.stringify([
    attachment.name || '', attachment.mimeType, attachment.dataUrl
  ])).digest('hex');
  return 'draft:' + digest;
}

function imageMetadata(attachment, imageRef) {
  return { name: attachment.name, mimeType: attachment.mimeType, imageRef };
}

function resolveChatImages(projectDir, chatId, refs) {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > 8 || refs.some((ref) => typeof ref !== 'string' || ref.length > 100)) {
    throw err('EBADINPUT', 'images must be an array of up to eight imageRef strings from list_chat_attachments');
  }
  if (!refs.length) return [];
  if (!projectDir || !chatId) throw err('EBADINPUT', 'images require a current chat and project');
  const chat = chats.getChat(projectDir, chatId);
  if (!chat) throw err('ENOTFOUND', 'Current chat not found');
  const out = [];
  let chars = 0;
  for (const ref of refs) {
    let attachment;
    if (/^draft:[a-f0-9]{64}$/.test(ref)) {
      attachment = (chat.draftAttachments || []).find((a) => draftImageRef(a) === ref);
    } else {
      const match = /^message:(\d+):([0-7])$/.exec(ref);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= Number.MAX_SAFE_INTEGER) {
        throw err('EBADINPUT', 'Invalid imageRef: ' + ref);
      }
      const seq = Number(match[1]);
      const row = messages.listMessagesWindow(projectDir, chatId, { beforeSeq: seq + 1, limit: 1 })[0];
      if (row && row.seq === seq && row.role === 'user') attachment = (row.attachments || [])[Number(match[2])];
    }
    const normalized = messages.normalizeAttachments(attachment ? [attachment] : []);
    if (!normalized.length) throw err('ENOTFOUND', 'Image reference is missing or stale; list_chat_attachments again: ' + ref);
    const image = normalized[0];
    chars += image.dataUrl.length;
    if (chars > 24 * 1024 * 1024) throw err('ETOOLARGE', 'Selected images exceed the 24 MiB encoded-input limit');
    out.push(image);
  }
  return out;
}

module.exports = { draftImageRef, imageMetadata, resolveChatImages };
