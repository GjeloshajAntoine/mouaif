// mouaif web — Chat image attachment helpers
//
// Pure-ish helpers for converting File objects (from <input> or
// paste) into the dataUrl payloads the chat composer attaches to
// the next user turn. The setImageAttachments setter is passed in
// because the state lives on the main view.

// fileToImageAttachment(file) -> Promise<{ type, mimeType, dataUrl, name } | null>
//
// Read a File as a data URL, returning null if the file is not one
// of the supported image types. The dataUrl is the same shape the
// API expects, so the same object can be uploaded as-is.
export function fileToImageAttachment(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpe?g|webp|gif)$/i.test(file.type || '')) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve({
      type: 'image',
      mimeType: file.type,
      dataUrl: String(reader.result || ''),
      name: file.name || 'image'
    });
    reader.onerror = () => reject(reader.error || new Error('image read failed'));
    reader.readAsDataURL(file);
  });
}

// addImagesFromFiles(files, { setImageAttachments, setChatStatus })
//
// Read a list of files, filter to images, and append the result to
// the image-attachments list (capped at 8). Surface a status pill
// so the user knows something happened.
export async function addImagesFromFiles(files, { setImageAttachments, setChatStatus }) {
  const list = Array.from(files || []).filter((f) => f && /^image\/(png|jpe?g|webp|gif)$/i.test(f.type || ''));
  if (!list.length) return;
  try {
    const items = (await Promise.all(list.map(fileToImageAttachment))).filter(Boolean);
    setImageAttachments((prev) => prev.concat(items).slice(0, 8));
    setChatStatus(
      items.length === 1 ? 'image attached' : (items.length + ' images attached'),
      'success'
    );
  } catch {
    setChatStatus('could not read image', 'error');
  }
}

// onComposerPaste(e, handlers)
//
// Paste handler that intercepts image files. preventDefault is only
// called when there is at least one image so a text paste still
// flows through normally.
export function onComposerPaste(e, handlers) {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && Array.from(files).some((f) => /^image\//i.test(f.type || ''))) {
    e.preventDefault();
    addImagesFromFiles(files, handlers);
  }
}

// onImagePickerChange(e, handlers)
//
// Bound to the hidden <input type="file" accept="image/*">. The
// value is cleared inside `send()` (so this handler doesn't need
// to); clearing here would race with send()'s later reset.
export function onImagePickerChange(e, handlers) {
  addImagesFromFiles(e.currentTarget.files, handlers);
}

// removeImageAttachment(idx, setImageAttachments)
export function removeImageAttachment(idx, setImageAttachments) {
  setImageAttachments((prev) => prev.filter((_, i) => i !== idx));
}
