'use strict';
// Base adapter interface and common utilities for AI provider implementations.

class BaseAIProvider {
  constructor(id, options = {}) {
    this.id = id;
    this.options = options;
  }

  // Normalize usage / token counts from upstream
  normalizeUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
    return {
      inputTokens: rawUsage.prompt_tokens || rawUsage.input_tokens || 0,
      outputTokens: rawUsage.completion_tokens || rawUsage.output_tokens || 0,
    cacheReadTokens: rawUsage.cache_read_input_tokens || (rawUsage.prompt_tokens_details && rawUsage.prompt_tokens_details.cached_tokens) || rawUsage.prompt_cache_hit_tokens || rawUsage.cached_tokens || 0,
      cacheWriteTokens: rawUsage.cache_creation_input_tokens || 0
    };
  }

  // Format tools to provider-specific schema
  formatTools(tools) {
    return tools;
  }

  // Hook for request building
  buildRequest(payload) {
    throw new Error(`buildRequest not implemented for provider ${this.id}`);
  }

  // Hook for event parsing
  parseEvent(event, data, state) {
    throw new Error(`parseEvent not implemented for provider ${this.id}`);
  }
}

module.exports = {
  BaseAIProvider
};
