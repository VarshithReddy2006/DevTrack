// src/shared/search/searchClient.ts
// Central search client factory and singleton provider resolver.

import { logger } from '../logger.js';
import type { ISearchProvider } from './searchClient.types.js';
import { InMemorySearchProvider } from './providers/inMemorySearchProvider.js';

let _activeProvider: ISearchProvider | null = null;

export function getSearchClient(): ISearchProvider {
  if (_activeProvider) {
    return _activeProvider;
  }

  const providerType = (process.env.SEARCH_PROVIDER || 'in-memory').toLowerCase().trim();

  switch (providerType) {
    case 'in-memory':
    default:
      _activeProvider = new InMemorySearchProvider();
      logger.info('[search] Initialized In-Memory search provider', {
        event: 'search_provider_initialized',
        provider: 'in-memory',
      });
      break;
  }

  return _activeProvider;
}

/**
 * Sets a custom search provider instance (used primarily in test suites).
 */
export function setSearchClient(provider: ISearchProvider | null): void {
  _activeProvider = provider;
}

/**
 * Resets the active search client singleton.
 */
export function resetSearchClient(): void {
  _activeProvider = null;
}
