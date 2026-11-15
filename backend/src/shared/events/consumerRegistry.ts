// src/shared/events/consumerRegistry.ts — Type-safe registry for domain event consumers
// Supports 'natural' and 'inbox' deduplication strategies across worker pools.

import type { ClientSession } from 'mongoose';
import type { DomainEventEnvelope } from './eventContract.js';

export type DedupStrategy = 'natural' | 'inbox';

export interface ConsumerDefinition<P = unknown> {
  name: string;
  pool?: string;
  dedup: DedupStrategy;
  handle: (event: DomainEventEnvelope<any, P>, session?: ClientSession) => Promise<void>;
}

export class ConsumerRegistry {
  private registry = new Map<string, ConsumerDefinition<any>[]>();

  /**
   * Registers a consumer for a specific domain event type.
   * If a consumer with the same name already exists for this event type, it replaces it.
   */
  register<P = unknown>(eventType: string, consumer: ConsumerDefinition<P>): void {
    const list = this.registry.get(eventType) || [];
    const existingIndex = list.findIndex(c => c.name === consumer.name);
    if (existingIndex >= 0) {
      list[existingIndex] = consumer;
    } else {
      list.push(consumer);
    }
    this.registry.set(eventType, list);
  }

  /**
   * Retrieves all consumers registered for the given event type.
   */
  getConsumers(eventType: string): ConsumerDefinition<any>[] {
    return this.registry.get(eventType) || [];
  }

  /**
   * Unregisters a consumer by name from a specific event type.
   * Returns true if a consumer was removed.
   */
  unregister(eventType: string, consumerName: string): boolean {
    const list = this.registry.get(eventType);
    if (!list) return false;
    const initialLen = list.length;
    const filtered = list.filter(c => c.name !== consumerName);
    if (filtered.length === initialLen) return false;
    if (filtered.length === 0) {
      this.registry.delete(eventType);
    } else {
      this.registry.set(eventType, filtered);
    }
    return true;
  }

  /**
   * Returns a list of all event types that have registered consumers.
   */
  getAllRegisteredEvents(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Clears all registered consumers. Useful for isolating test cases.
   */
  clear(): void {
    this.registry.clear();
  }
}

export const consumerRegistry = new ConsumerRegistry();

export function registerConsumer<P = unknown>(
  eventType: string,
  consumer: ConsumerDefinition<P>
): void {
  consumerRegistry.register(eventType, consumer);
}

export function getConsumersForEvent(eventType: string): ConsumerDefinition<any>[] {
  return consumerRegistry.getConsumers(eventType);
}

export function clearConsumerRegistry(): void {
  consumerRegistry.clear();
}
