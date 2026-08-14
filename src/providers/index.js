'use strict';
// Registry for AI providers in mouaif.

const { BaseAIProvider } = require('./base.js');

const providerRegistry = new Map();

function registerProvider(id, providerInstance) {
  providerRegistry.set(id, providerInstance);
}

function getProvider(id) {
  return providerRegistry.get(id);
}

function listRegisteredProviders() {
  return Array.from(providerRegistry.keys());
}

module.exports = {
  BaseAIProvider,
  registerProvider,
  getProvider,
  listRegisteredProviders
};
