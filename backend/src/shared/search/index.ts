// src/shared/search/index.ts
// Barrel export for the search module contracts, providers, and client factory.

export * from './searchClient.types.js';
export * from './documentMappers.js';
export * from './searchResumeToken.js';
export * from './searchLeaderLock.js';
export { InMemorySearchProvider, levenshteinDistance } from './providers/inMemorySearchProvider.js';
export { getSearchClient, setSearchClient, resetSearchClient } from './searchClient.js';
