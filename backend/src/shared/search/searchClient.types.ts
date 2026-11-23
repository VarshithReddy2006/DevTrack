// src/shared/search/searchClient.types.ts
// Core contracts and type definitions for the search provider abstraction.

export type SearchEntityType = 'dsa' | 'profile' | 'project';

export interface SearchDocument {
  id: string;
  type: SearchEntityType;
  title: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  updatedAt?: number;
}

export interface SearchOptions {
  type?: SearchEntityType | 'all';
  limit?: number;
  offset?: number;
  filters?: Record<string, unknown>;
}

export interface SearchHit<T = SearchDocument> {
  id: string;
  type: SearchEntityType;
  score: number;
  document: T;
  highlights?: Record<string, string>;
}

export interface SearchResult<T = SearchDocument> {
  query: string;
  totalHits: number;
  hits: SearchHit<T>[];
  processingTimeMs: number;
  limit: number;
  offset: number;
}

export interface ISearchProvider {
  readonly name: string;

  /**
   * Idempotently indexes or updates a single document by ID.
   */
  indexDocument(index: string, id: string, doc: SearchDocument): Promise<void>;

  /**
   * Idempotently indexes or updates a batch of documents in a single operation.
   */
  indexDocuments(index: string, docs: Array<{ id: string; doc: SearchDocument }>): Promise<void>;

  /**
   * Removes a document by ID. Returns cleanly without error if the document does not exist.
   * Optional deletedAt timestamp records a deletion tombstone for version fencing.
   */
  deleteDocument(index: string, id: string, deletedAt?: number): Promise<void>;

  /**
   * Removes multiple documents by ID.
   */
  deleteDocuments(index: string, ids: Array<string | { id: string; deletedAt?: number }>): Promise<void>;

  /**
   * Executes a search query with optional type filtering and pagination.
   */
  search<T = SearchDocument>(index: string, query: string, options?: SearchOptions): Promise<SearchResult<T>>;

  /**
   * Clears a specific index or all indices. Used for testing and full resync.
   */
  clear(index?: string): Promise<void>;

  /**
   * Health check verifying provider availability.
   */
  healthCheck(): Promise<boolean>;
}
