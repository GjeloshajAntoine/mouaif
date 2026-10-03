'use strict';

// Explicit references to images already stored in the current chat. Never
// scan or transfer the whole transcript, and never accept base64 tool args.
//
// Reference shapes:
//   draft:<sha256>          — a composer draft image (content-addressed)
//   message:<seq>:<index>   — an attachment on a persisted user message
//   generated:<seq>:<index> — an image a subagent returned, stored on its
//                             persisted `subagent` tool-result row
const { createHash } = require('node:crypto');
const chats = require('./chats.js');
const messages = require('./messages.js');
const { err } = require('./util.js');

const MAX_REFS = 8;
const MAX_TOTAL_CHARS = 24 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function draftImageRef(attachment) {
  const digest = createHash('sha256').update(JSON.stringify([
    attachment.name || '', attachment.mimeType, attachment.dataUrl
  ])).digest('hex');
  return 'draft:' + digest;
}

function imageMetadata(attachment, imageRef) {
  return { name: attachment.name, mimeType: attachment.mimeType, imageRef };
}

// generatedImageBlocks(result) -> Array<{ type:'image', data, mimeType }>
//
// The image blocks a delegated run returned on its result `content`, in the
// order the parent model received them. `result` is the parsed tool result.
function generatedImageBlocks(result) {
  const content = result && typeof result === 'object' && Array.isArray(result.content) ? result.content : [];
  return content.filter((block) => block && block.type === 'image'
    && typeof block.data === 'string' && block.data).slice(0, MAX_REFS);
}

function isSubagentResultRow(row) {
  return !!row && row.role === 'tool' && row.phase === 'result' && row.name === 'subagent';
}

function parseRowResult(row) {
  try { return JSON.parse(typeof row.content === 'string' ? row.content : ''); }
  catch { return null; }
}

// generatedImageRefs(seq, result) -> string[]
//
// Stable references for the images on a persisted subagent result row.
function generatedImageRefs(seq, result) {
  if (!Number.isSafeInteger(seq) || seq < 0) return [];
  return generatedImageBlocks(result).map((_, index) => 'generated:' + seq + ':' + index);
}

// generatedAttachment(seq, index, block) -> attachment
//
// Re-shape a returned image block as an ordinary chat attachment so it goes
// through the same validation as composer images.
function generatedAttachment(seq, index, block) {
  let mimeType = String(block.mimeType || 'image/png').toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  let dataUrl;
  const inline = /^data:(image\/[a-z+.-]+);base64,/i.exec(block.data);
  if (inline) {
    mimeType = inline[1].toLowerCase();
    dataUrl = block.data;
  } else {
    dataUrl = 'data:' + mimeType + ';base64,' + block.data.replace(/\s+/g, '');
  }
  return { type: 'image', mimeType, dataUrl, name: 'generated-' + seq + '-' + index + '.' + (EXT[mimeType] || 'img') };
}

function rowAt(projectDir, chatId, seq) {
  const row = messages.listMessagesWindow(projectDir, chatId, { beforeSeq: seq + 1, limit: 1 })[0];
  return row && row.seq === seq ? row : null;
}

// listGeneratedImages(row) -> Array<metadata> for list_chat_attachments.
function listGeneratedImages(row) {
  if (!isSubagentResultRow(row)) return [];
  const result = parseRowResult(row);
  return generatedImageBlocks(result).map((block, index) => {
    const a = generatedAttachment(row.seq, index, block);
    return imageMetadata(a, 'generated:' + row.seq + ':' + index);
  });
}

function parseRef(ref) {
  if (/^draft:[a-f0-9]{64}$/.test(ref)) return { kind: 'draft' };
  const match = /^(message|generated):(\d+):([0-7])$/.exec(ref);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) >= Number.MAX_SAFE_INTEGER) return null;
  return { kind: match[1], seq: Number(match[2]), index: Number(match[3]) };
}

// Look up one reference. Returns an unvalidated attachment or null.
function lookupRef(projectDir, chatId, chat, ref, parsed) {
  if (parsed.kind === 'draft') {
    return (chat.draftAttachments || []).find((a) => draftImageRef(a) === ref) || null;
  }
  const row = rowAt(projectDir, chatId, parsed.seq);
  if (!row) return null;
  if (parsed.kind === 'message') {
    return row.role === 'user' ? ((row.attachments || [])[parsed.index] || null) : null;
  }
  if (!isSubagentResultRow(row)) return null;
  const block = generatedImageBlocks(parseRowResult(row))[parsed.index];
  return block ? generatedAttachment(row.seq, parsed.index, block) : null;
}

function validRefList(refs) {
  return Array.isArray(refs) && refs.length <= MAX_REFS
    && refs.every((ref) => typeof ref === 'string' && ref.length <= 100);
}

function resolveChatImages(projectDir, chatId, refs) {
  if (refs === undefined) return [];
  if (!validRefList(refs)) {
    throw err('EBADINPUT', 'images must be an array of up to eight imageRef strings from list_chat_attachments');
  }
  if (!refs.length) return [];
  if (!projectDir || !chatId) throw err('EBADINPUT', 'images require a current chat and project');
  const chat = chats.getChat(projectDir, chatId);
  if (!chat) throw err('ENOTFOUND', 'Current chat not found');
  const out = [];
  let chars = 0;
  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed) throw err('EBADINPUT', 'Invalid imageRef: ' + ref);
    const attachment = lookupRef(projectDir, chatId, chat, ref, parsed);
    const normalized = messages.normalizeAttachments(attachment ? [attachment] : []);
    if (!normalized.length) throw err('ENOTFOUND', 'Image reference is missing or stale; list_chat_attachments again: ' + ref);
    const image = normalized[0];
    chars += image.dataUrl.length;
    if (chars > MAX_TOTAL_CHARS) throw err('ETOOLARGE', 'Selected images exceed the 24 MiB encoded-input limit');
    out.push(image);
  }
  return out;
}

// describeChatImages(projectDir, chatId, refs) -> Array<{ imageRef, name?, mimeType?, missing? }>
//
// Pixel-free summary for the authorization card, so the user sees what a
// delegation would share before approving it. Never throws: malformed input
// is reported by resolveChatImages when the approved call runs.
function describeChatImages(projectDir, chatId, refs) {
  if (!validRefList(refs) || !refs.length || !projectDir || !chatId) return [];
  let chat;
  try { chat = chats.getChat(projectDir, chatId); } catch { chat = null; }
  return refs.map((ref) => {
    const parsed = parseRef(ref);
    let attachment = null;
    if (parsed && chat) {
      try { attachment = lookupRef(projectDir, chatId, chat, ref, parsed); } catch { attachment = null; }
    }
    const normalized = messages.normalizeAttachments(attachment ? [attachment] : []);
    if (!normalized.length) return { imageRef: ref, missing: true };
    return { imageRef: ref, name: normalized[0].name || '', mimeType: normalized[0].mimeType };
  });
}

module.exports = {
  draftImageRef, imageMetadata, resolveChatImages, describeChatImages,
  generatedImageBlocks, generatedImageRefs, listGeneratedImages
};
