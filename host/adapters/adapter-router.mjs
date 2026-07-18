function adapterForPage(page = {}) {
  const url = String(page.url || '').toLowerCase();
  const pageType = String(page.pageType || '').toLowerCase();
  if (/(?:larksuite|feishu)\.com/.test(url) || pageType === 'document') {
    return {
      id: 'lark_document',
      capabilities: {
        structure: 'derived', text: 'on_demand', images: 'on_demand', tables: 'on_demand',
        actions: ['scroll_into_view', 'focus'], revisionDetection: 'best_effort',
      },
    };
  }
  if (/figma\.com/.test(url) || pageType === 'figma') {
    return {
      id: 'figma_visual_fallback',
      capabilities: {
        structure: 'visual_only', text: 'visible_only', images: 'visible_only', tables: 'unsupported',
        actions: ['scroll_into_view', 'focus'], revisionDetection: 'unknown',
      },
    };
  }
  if (pageType === 'spreadsheet' || pageType === 'data_application') {
    return {
      id: 'virtual_grid',
      capabilities: {
        structure: 'derived', text: 'on_demand', images: 'visible_only', tables: 'on_demand',
        actions: ['scroll_into_view', 'focus', 'click', 'input', 'select'], revisionDetection: 'unknown',
      },
    };
  }
  if (pageType === 'canvas_application') {
    return {
      id: 'canvas_visual_fallback',
      capabilities: {
        structure: 'visual_only', text: 'visible_only', images: 'visible_only', tables: 'unsupported',
        actions: ['scroll_into_view', 'focus'], revisionDetection: 'unknown',
      },
    };
  }
  return {
    id: 'generic_dom',
    capabilities: {
      structure: 'derived', text: 'on_demand', images: 'visible_only', tables: 'on_demand',
      actions: ['scroll_into_view', 'focus', 'click', 'input', 'select', 'submit'], revisionDetection: 'unknown',
    },
  };
}

export { adapterForPage };
