(() => {
  'use strict';

  if (globalThis.__CLAUDE_SIDEBAR_CHAT_ATTACHMENTS_V0133__) return;
  globalThis.__CLAUDE_SIDEBAR_CHAT_ATTACHMENTS_V0133__ = true;

  const MAX_FILES = 4;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
  const state = { items: [], input: null, sendButton: null, strip: null, button: null, notice: null, composer: null, trayParent: null };

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function toast(text, kind = 'info') {
    let node = state.notice;
    if (!node) {
      node = document.createElement('div');
      node.id = 'claude-sidebar-attachment-notice';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
      state.notice = node;
    }
    node.textContent = text;
    node.dataset.kind = kind;
    node.hidden = false;
    clearTimeout(node.__hideTimer);
    node.__hideTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  function readyItems() {
    return state.items.filter((item) => item.status === 'ready');
  }

  function hasReady() {
    return readyItems().length > 0;
  }

  function isLoading() {
    return state.items.some((item) => item.status === 'loading');
  }

  function updateSendButton() {
    const input = state.input;
    const button = state.sendButton;
    if (!button) return;
    if (isLoading()) {
      button.disabled = true;
      button.dataset.attachmentBusy = 'true';
      return;
    }
    delete button.dataset.attachmentBusy;
    const text = input ? String(input.value ?? input.textContent ?? '').trim() : '';
    if (hasReady() || text) button.disabled = false;
  }

  function removeItem(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.items.splice(index, 1);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    render();
  }

  function render() {
    if (!state.strip) return;
    state.strip.replaceChildren();
    state.strip.hidden = state.items.length === 0;
    for (const item of state.items) {
      const chip = document.createElement('div');
      chip.className = 'claude-sidebar-attachment-chip';
      chip.dataset.status = item.status;

      if (item.previewUrl) {
        const image = document.createElement('img');
        image.src = item.previewUrl;
        image.alt = '';
        chip.appendChild(image);
      } else {
        const icon = document.createElement('span');
        icon.className = 'claude-sidebar-attachment-file-icon';
        icon.textContent = 'FILE';
        chip.appendChild(icon);
      }

      const copy = document.createElement('span');
      copy.className = 'claude-sidebar-attachment-copy';
      const name = document.createElement('span');
      name.className = 'claude-sidebar-attachment-name';
      name.textContent = item.name;
      name.title = item.name;
      const meta = document.createElement('span');
      meta.className = 'claude-sidebar-attachment-meta';
      meta.textContent = item.status === 'loading'
        ? '正在读取…'
        : item.status === 'error'
          ? item.error || '读取失败'
          : formatBytes(item.size);
      copy.append(name, meta);
      chip.appendChild(copy);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'claude-sidebar-attachment-remove';
      remove.setAttribute('aria-label', `移除 ${item.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeItem(item.id));
      chip.appendChild(remove);
      state.strip.appendChild(chip);
    }
    updateSendButton();
  }

  function dataUrlToBase64(dataUrl) {
    const comma = String(dataUrl || '').indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : '';
  }

  function readFile(file, item) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => {
        item.status = 'error';
        item.error = '无法读取文件';
        render();
        resolve();
      };
      reader.onload = () => {
        const data = dataUrlToBase64(reader.result);
        if (!data) {
          item.status = 'error';
          item.error = '文件编码失败';
        } else {
          item.data = data;
          item.status = 'ready';
        }
        render();
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    let total = state.items.reduce((sum, item) => sum + Number(item.size || 0), 0);
    for (const file of files) {
      if (state.items.length >= MAX_FILES) {
        toast(`一次最多添加 ${MAX_FILES} 个附件`, 'error');
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast(`${file.name} 超过单文件 10 MB 限制`, 'error');
        continue;
      }
      if (total + file.size > MAX_TOTAL_BYTES) {
        toast('附件总大小不能超过 24 MB', 'error');
        break;
      }
      total += file.size;
      const item = {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || 'attachment',
        type: file.type || 'application/octet-stream',
        size: file.size,
        lastModified: file.lastModified || null,
        status: 'loading',
        data: null,
        previewUrl: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null,
      };
      state.items.push(item);
      render();
      await readFile(file, item);
    }
  }

  function takeReady() {
    if (isLoading()) {
      toast('附件仍在读取，请稍后发送', 'error');
      return [];
    }
    const ready = readyItems().map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.type,
      size: item.size,
      lastModified: item.lastModified,
      data: item.data,
    }));
    if (!ready.length) return [];
    for (const item of state.items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    state.items = state.items.filter((item) => item.status !== 'ready');
    render();
    return ready;
  }

  function findComposer() {
    const input = document.querySelector(
      '#prompt-input, #promptInput, #prompt, #message-input, #messageInput, textarea, [contenteditable="true"][role="textbox"]'
    );
    if (!input) return null;
    const composer = input.closest('form, .composer, .input-area, .prompt-area, .chat-input, [data-composer]') || input.parentElement;
    const sendButton = composer?.querySelector(
      '#send-button, #sendButton, button[type="submit"], button[aria-label*="send" i], button[title*="send" i], [data-action="send"]'
    ) || document.querySelector('#send-button, #sendButton, button[aria-label*="send" i], button[title*="send" i]');
    return { input, composer, sendButton };
  }

  function installStyles() {
    if (document.getElementById('claude-sidebar-attachment-styles')) return;
    const style = document.createElement('style');
    style.id = 'claude-sidebar-attachment-styles';
    style.textContent = `
      #claude-sidebar-attachment-strip{position:relative;z-index:1;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;box-sizing:border-box;width:100%;max-width:100%;min-height:0;flex:0 0 auto;padding:4px 2px 7px;margin:0;}
      #claude-sidebar-attachment-strip[hidden]{display:none;}
      .claude-sidebar-attachment-chip{display:flex;align-items:center;gap:8px;min-width:0;max-width:220px;padding:6px 7px;border:1px solid rgba(127,127,127,.28);border-radius:10px;background:rgba(127,127,127,.08);font:12px/1.25 system-ui,sans-serif;}
      .claude-sidebar-attachment-chip[data-status="error"]{border-color:#d55;background:rgba(220,70,70,.08);}
      .claude-sidebar-attachment-chip img{width:34px;height:34px;object-fit:cover;border-radius:7px;flex:none;}
      .claude-sidebar-attachment-file-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:7px;background:rgba(80,120,220,.12);font-size:9px;font-weight:700;flex:none;}
      .claude-sidebar-attachment-copy{display:flex;flex-direction:column;min-width:0;flex:1;}
      .claude-sidebar-attachment-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;}
      .claude-sidebar-attachment-meta{opacity:.65;margin-top:2px;}
      .claude-sidebar-attachment-remove{border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;opacity:.65;padding:2px;}
      #claude-sidebar-attach-button{display:inline-grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;cursor:pointer;font-size:18px;opacity:.75;flex:none;}
      #claude-sidebar-attach-button:hover{background:rgba(127,127,127,.12);opacity:1;}
      #claude-sidebar-attachment-notice{position:fixed;left:12px;right:12px;bottom:18px;z-index:2147483647;padding:9px 11px;border-radius:9px;background:#222;color:#fff;font:12px/1.35 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.22);pointer-events:none;}
      #claude-sidebar-attachment-notice[data-kind="error"]{background:#9f2f2f;}
      body.claude-sidebar-file-drag::after{content:'松开以添加图片或文件';position:fixed;inset:8px;z-index:2147483646;display:grid;place-items:center;border:2px dashed #5d83df;border-radius:14px;background:rgba(70,110,210,.12);color:inherit;font:600 14px system-ui,sans-serif;pointer-events:none;}
    `;
    document.head.appendChild(style);
  }

  function mount() {
    const found = findComposer();
    if (!found || document.getElementById('claude-sidebar-attach-button')) return false;
    installStyles();
    state.input = found.input;
    state.sendButton = found.sendButton;

    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'file';
    hiddenInput.multiple = true;
    hiddenInput.hidden = true;
    hiddenInput.id = 'claude-sidebar-attachment-input';
    hiddenInput.addEventListener('change', async () => {
      await addFiles(hiddenInput.files);
      hiddenInput.value = '';
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'claude-sidebar-attach-button';
    button.setAttribute('aria-label', '添加图片或文件');
    button.title = '添加图片或文件';
    button.textContent = '📎';
    button.addEventListener('click', () => hiddenInput.click());

    const strip = document.createElement('div');
    strip.id = 'claude-sidebar-attachment-strip';
    strip.hidden = true;

    const composer = found.composer || found.input.parentElement;
    const trayParent = composer?.parentElement;
    // The attachment tray must be a sibling above the composer. Putting it inside
    // the composer breaks fixed-height/absolute layouts and can cover the input.
    if (trayParent) trayParent.insertBefore(strip, composer);
    else composer.insertBefore(strip, composer.firstChild);
    if (found.sendButton?.parentElement) found.sendButton.parentElement.insertBefore(button, found.sendButton);
    else composer.appendChild(button);
    composer.appendChild(hiddenInput);

    state.composer = composer;
    state.trayParent = trayParent;
    state.strip = strip;
    state.button = button;
    render();

    found.input.addEventListener('input', updateSendButton);
    composer.addEventListener('click', (event) => {
      const target = event.target?.closest?.('button');
      if (target === state.sendButton && isLoading()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast('附件仍在读取，请稍后发送', 'error');
      }
    }, true);
    found.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && isLoading()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast('附件仍在读取，请稍后发送', 'error');
      }
    }, true);
    return true;
  }

  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth += 1;
    document.body.classList.add('claude-sidebar-file-drag');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('claude-sidebar-file-drag');
  });
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('claude-sidebar-file-drag');
    await addFiles(event.dataTransfer.files);
  });
  document.addEventListener('paste', async (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    await addFiles(files);
  });

  globalThis.__claudeSidebarAttachments = {
    version: '0.15.3',
    hasReady,
    isLoading,
    takeReady,
    addFiles,
    getState: () => state.items.map(({ data, previewUrl, ...item }) => ({ ...item, encoded: Boolean(data), preview: Boolean(previewUrl) })),
  };

  const boot = () => {
    if (mount()) return;
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
