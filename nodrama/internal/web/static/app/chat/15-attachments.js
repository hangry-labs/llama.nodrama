"use strict";

const CHAT_ATTACHMENT_MAX_COUNT = 8;
const CHAT_TEXT_MAX_BYTES = 256 * 1024;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

function chatImageSupport() {
  const model = [...(state.models || []), ...(state.v1models || [])].find(model =>
    model.id === state.selectedModel || model.aliases?.includes(state.selectedModel));
  const modalities = model?.architecture?.input_modalities || model?.meta?.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes('image') || modalities.includes('vision');
  if (typeof model?.meta?.modalities?.vision === 'boolean') return model.meta.modalities.vision;
  if (state.mode !== 'router' || state.props?.model_alias === state.selectedModel) {
    if (typeof state.props?.modalities?.vision === 'boolean') return state.props.modalities.vision;
    if (typeof state.props?.chat_template_caps?.vision === 'boolean') return state.props.chat_template_caps.vision;
  }
  return null;
}

function chatUserContent(message) {
  const attachments = message.attachments || [];
  let text = message.content || '';
  for (const attachment of attachments.filter(item => item.kind === 'text')) {
    // A named text block, not Markdown interpolation or executable markup.
    text += '\n\n--- Attached file: ' + attachment.name + ' ---\n' + attachment.text + '\n--- End attached file ---';
  }
  const images = attachments.filter(item => item.kind === 'image');
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map(item => ({ type: 'image_url', image_url: { url: item.dataURL } }))];
}

async function prepareChatAttachment(file) {
  const name = String(file.name || 'pasted-image').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 180);
  const image = /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  if (image) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error(t('chat.attachment_image_size'));
    // Normalize browser-supported formats to PNG/JPEG, also accepted by older
    // llama.cpp image decoders. Bound resolution, encoded size and memory.
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let dataURL = canvas.toDataURL('image/png');
      if (dataURL.length > 700 * 1024) dataURL = canvas.toDataURL('image/jpeg', 0.82);
      if (dataURL.length > 1024 * 1024) throw new Error(t('chat.attachment_image_size'));
      return { kind: 'image', name, size: file.size, dataURL };
    } finally { bitmap.close(); }
  }
  if (/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|bz2|xz|7z|rar|exe|dll)$/i.test(name)
      || /^(audio\/|video\/|application\/pdf)/i.test(file.type)) {
    throw new Error(t('chat.attachment_type'));
  }
  if (file.size > CHAT_TEXT_MAX_BYTES) throw new Error(t('chat.attachment_text_size'));
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { throw new Error(t('chat.attachment_encoding')); }
  if (text.startsWith('%PDF-')) throw new Error(t('chat.attachment_type'));
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error(t('chat.attachment_encoding'));
  return { kind: 'text', name, size: file.size, text };
}

async function addChatAttachments(files) {
  if (chat.inflight || chat.attachmentLoading) return;
  chat.attachmentLoading = true;
  renderChatAttachments('');
  const errors = [];
  try {
    for (const file of Array.from(files)) {
      if (chat.attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) {
        errors.push(t('chat.attachment_count')); break;
      }
      try { chat.attachments.push(await prepareChatAttachment(file)); }
      catch (error) { errors.push(file.name + ': ' + error.message); }
    }
  } finally {
    chat.attachmentLoading = false;
    renderChatAttachments(errors.join(' · '));
  }
}

function renderChatAttachments(error) {
  if (error !== undefined) chat.attachmentError = error;
  const list = $('#chat-attachments');
  if (!list) return;
  list.replaceChildren();
  for (const [index, item] of chat.attachments.entries()) {
    const remove = el('button', { type: 'button', class: 'attachment-remove',
      title: t('chat.attachment_remove', { name: item.name }),
      'aria-label': t('chat.attachment_remove', { name: item.name }),
      disabled: !!chat.inflight || chat.attachmentLoading,
      onclick: () => { chat.attachments.splice(index, 1); renderChatAttachments(''); } }, '×');
    list.appendChild(el('div', { class: 'chat-attachment' }, [
      item.kind === 'image' ? el('img', { src: item.dataURL, alt: '' }) : el('span', { class: 'attachment-file', 'aria-hidden': 'true' }, '≡'),
      el('span', { title: item.name }, item.name), remove,
    ]));
  }
  list.hidden = !chat.attachments.length;
  const status = $('#chat-attachment-status');
  if (status) {
    const hasImages = chat.attachments.some(item => item.kind === 'image');
    const support = hasImages ? chatImageSupport() : true;
    status.textContent = chat.attachmentError || (chat.attachmentLoading ? t('common.loading') :
      hasImages && support === false ? t('chat.attachment_no_vision') :
      hasImages && support === null ? t('chat.attachment_vision_unknown') : '');
    status.hidden = !status.textContent;
  }
  for (const id of ['#chat-attach', '#chat-files', '#chat-send']) {
    const node = $(id); if (node) node.disabled = !!chat.inflight || chat.attachmentLoading;
  }
}

function wireChatAttachments(composer, textarea) {
  textarea.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault(); void addChatAttachments(files);
  });
  composer.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); composer.classList.add('drag-over');
  });
  composer.addEventListener('dragleave', event => {
    if (!composer.contains(event.relatedTarget)) composer.classList.remove('drag-over');
  });
  composer.addEventListener('drop', event => {
    composer.classList.remove('drag-over');
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); void addChatAttachments(event.dataTransfer.files);
  });
}
