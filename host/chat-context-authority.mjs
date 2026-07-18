export function cleanPage(page) {
  if (!page || !Number(page.tabId)) return null;
  return {
    ...page,
    tabId: Number(page.tabId),
    title: String(page.title || page.alias || ''),
    url: String(page.url || ''),
  };
}

export function createChatContextAuthority() {
  let authoritativeSelection = null;

  function update(message) {
    const selection = message?.selection && typeof message.selection === 'object' ? message.selection : {};
    authoritativeSelection = {
      mode: selection.mode === 'pinned' ? 'pinned' : 'follow',
      pinnedPage: cleanPage(selection.pinnedPage),
      nextPage: cleanPage(selection.nextPage),
      currentPage: cleanPage(selection.currentPage),
      projectPages: Array.isArray(selection.projectPages) ? selection.projectPages.map(cleanPage).filter(Boolean) : [],
      task: selection.task || null,
      syncedAt: selection.syncedAt || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      authority: message?.authority || 'extension_page_selection',
    };
    return snapshot();
  }

  function snapshot() {
    return authoritativeSelection ? structuredClone(authoritativeSelection) : null;
  }

  function contextSelectionSource(context) {
    return String(context?.task?.selectionSource || context?.selectionSource || '');
  }

  function hasExplicitMessageTarget(context) {
    return ['explicit_message_target', 'next_message_page', 'explicit_page', 'message_page_override'].includes(contextSelectionSource(context));
  }

  function resolveInteractionContext(message) {
    const incoming = message?.interactionContext && typeof message.interactionContext === 'object'
      ? structuredClone(message.interactionContext)
      : {};
    const authority = authoritativeSelection;
    if (!authority) return incoming;

    if (hasExplicitMessageTarget(incoming) && cleanPage(incoming?.task?.page || incoming?.page || incoming?.identity)) {
      return incoming;
    }

    let selectedPage = null;
    let selectionSource = '';
    if (authority.nextPage) {
      selectedPage = authority.nextPage;
      selectionSource = 'next_message_page_host_authority';
      authoritativeSelection = { ...authority, nextPage: null };
    } else if (authority.mode === 'pinned') {
      if (!authority.pinnedPage || authority.pinnedPage.unavailable) {
        const error = new Error('The page selected for all future messages is unavailable.');
        error.code = 'pinned_page_unavailable';
        error.selection = snapshot();
        throw error;
      }
      selectedPage = authority.pinnedPage;
      selectionSource = 'pinned_page_host_authority';
    }

    if (!selectedPage) return incoming;
    const existingTask = incoming.task && typeof incoming.task === 'object' ? incoming.task : {};
    return {
      ...incoming,
      ok: true,
      authoritative: true,
      authoritySource: 'chat_native_host',
      mode: authority.mode,
      selectionSource,
      pinnedPage: authority.pinnedPage,
      nextPage: authoritativeSelection?.nextPage || null,
      projectPages: authority.projectPages,
      workspace: authority.projectPages,
      task: {
        ...existingTask,
        id: existingTask.id || `host-task-${Date.now().toString(36)}`,
        status: existingTask.status || 'running',
        selectionSource,
        pageSelectionMode: authority.mode,
        primaryPage: selectedPage,
        page: selectedPage,
      },
    };
  }

  function apply(message) {
    const copy = structuredClone(message || {});
    copy.interactionContext = resolveInteractionContext(copy);
    return copy;
  }

  return { update, snapshot, resolveInteractionContext, apply, hasExplicitMessageTarget };
}
