(() => {
  'use strict';
  if (globalThis.__CLAUDE_SIDEBAR_CONTENT_V013__) return;
  globalThis.__CLAUDE_SIDEBAR_CONTENT_V013__ = true;

  const refs = new Map();
  let refCounter = 0;

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function refFor(element) {
    for (const [ref, value] of refs) if (value === element) return ref;
    const ref = `ref_${++refCounter}`;
    refs.set(ref, element);
    if (refs.size > 2000) refs.delete(refs.keys().next().value);
    return ref;
  }

  function nameFor(element) {
    return String(
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      element.textContent ||
      ''
    ).trim().replace(/\s+/g, ' ').slice(0, 500);
  }

  function roleFor(element) {
    return element.getAttribute('role') || ({
      A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox',
      TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', IMG: 'img', NAV: 'navigation',
      MAIN: 'main', FORM: 'form', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading'
    }[element.tagName] || element.tagName.toLowerCase());
  }

  function interactive(element) {
    const tag = element.tagName;
    return ['A','BUTTON','INPUT','TEXTAREA','SELECT','OPTION','SUMMARY'].includes(tag) ||
      element.hasAttribute('onclick') || element.tabIndex >= 0 || Boolean(element.getAttribute('role'));
  }

  function readPage(options = {}) {
    refs.clear();
    const maxNodes = Math.max(20, Math.min(2500, Number(options.maxNodes || 800)));
    const maxChars = Math.max(2000, Math.min(120000, Number(options.maxChars || 30000)));
    const selectors = 'main,article,nav,form,h1,h2,h3,h4,h5,h6,a,button,input,textarea,select,table,tr,th,td,[role],[aria-label],[contenteditable="true"]';
    const nodes = [];
    let chars = 0;
    for (const element of document.querySelectorAll(selectors)) {
      if (nodes.length >= maxNodes || chars >= maxChars || !visible(element)) continue;
      const name = nameFor(element);
      if (!name && !interactive(element)) continue;
      const rect = element.getBoundingClientRect();
      const item = {
        ref: refFor(element), role: roleFor(element), name,
        tag: element.tagName.toLowerCase(),
        href: element.href || null,
        value: 'value' in element ? String(element.value ?? '').slice(0, 500) : null,
        checked: 'checked' in element ? Boolean(element.checked) : null,
        disabled: Boolean(element.disabled),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
      chars += JSON.stringify(item).length;
      nodes.push(item);
    }
    return {
      ok: true,
      title: document.title,
      url: location.href,
      nodes,
      text: String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, maxChars),
      truncated: nodes.length >= maxNodes || chars >= maxChars,
    };
  }

  function findElements(query, limit = 20) {
    refs.clear();
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = [...document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[title],[contenteditable="true"]')];
    const scored = [];
    for (const element of candidates) {
      if (!visible(element)) continue;
      const name = nameFor(element);
      const haystack = `${name} ${element.id || ''} ${element.className || ''} ${roleFor(element)}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      const score = terms.reduce((sum, term) => sum + (name.toLowerCase().includes(term) ? 5 : 1), 0) + (interactive(element) ? 2 : 0);
      const rect = element.getBoundingClientRect();
      scored.push({ ref: refFor(element), role: roleFor(element), name, score, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }
    scored.sort((a,b) => b.score - a.score);
    return { ok: true, query, matches: scored.slice(0, Math.max(1, Math.min(100, Number(limit || 20)))), total: scored.length };
  }

  function setValue(element, value) {
    if (!element) return { ok: false, code: 'ref_not_found' };
    if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = Boolean(value);
    else if (element instanceof HTMLInputElement && element.type === 'radio') element.checked = Boolean(value);
    else if (element instanceof HTMLSelectElement) {
      const match = [...element.options].find((option) => option.value === String(value) || option.text === String(value));
      element.value = match?.value ?? String(value);
    } else if ('value' in element) element.value = String(value ?? '');
    else if (element.isContentEditable) element.textContent = String(value ?? '');
    else return { ok: false, code: 'element_not_editable' };
    for (const type of ['input','change','blur']) element.dispatchEvent(new Event(type, { bubbles: true }));
    return { ok: true, ref: [...refs].find(([,node]) => node === element)?.[0] || null };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === 'readPage') sendResponse({ result: readPage(message.options) });
      else if (message?.type === 'getPageText') sendResponse({ result: { ok: true, title: document.title, url: location.href, text: String(document.body?.innerText || '').slice(0, Number(message.maxChars || 100000)) } });
      else if (message?.type === 'findElements') sendResponse({ result: findElements(message.query, message.limit) });
      else if (message?.type === 'setFormValue') sendResponse({ result: setValue(refs.get(message.ref), message.value) });
      else if (message?.type === 'getRefCoordinates') {
        const element = refs.get(message.ref);
        if (!element) sendResponse({ result: null });
        else {
          const rect = element.getBoundingClientRect();
          sendResponse({ result: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } });
        }
      } else if (message?.type === 'scrollRefIntoView') {
        const element = refs.get(message.ref);
        if (!element) sendResponse({ result: { ok: false, code: 'ref_not_found' } });
        else { element.scrollIntoView({ block: message.block || 'center', inline: 'nearest', behavior: 'instant' }); sendResponse({ result: { ok: true } }); }
      } else sendResponse({ result: { ok: false, code: 'unknown_content_message' } });
    } catch (error) {
      sendResponse({ result: { ok: false, error: String(error?.message || error) } });
    }
    return true;
  });
})();
