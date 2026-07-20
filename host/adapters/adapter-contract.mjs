const STRUCTURE_LEVELS = new Set(['authoritative', 'derived', 'viewport_only', 'visual_only', 'unsupported']);

function validateAdapterCapabilities(capabilities = {}) {
  const errors = [];
  if (!STRUCTURE_LEVELS.has(capabilities.structure)) errors.push('structure_level_invalid');
  if (!Array.isArray(capabilities.actions)) errors.push('actions_must_be_array');
  return { ok: errors.length === 0, errors };
}

export { STRUCTURE_LEVELS, validateAdapterCapabilities };
