import { logger } from '../../../shared/logger.js';

export class ProviderFailoverRuntime {
  async executeWithFailover(operation: () => Promise<any>): Promise<any> {
    try {
      return await operation();
    } catch (error) {
      // Provider selection and circuit admission belong to the adapter used by the operation.
      logger.warn('[ProviderFailover] Operation failed, retrying.', { error });
      try {
        return await operation();
      } catch (fallbackError) {
        logger.error('[ProviderFailover] Fallback also failed. Using degraded mode.', { fallbackError });
        return { content: 'AI services are currently unavailable (degraded mode)' };
      }
    }
  }
}
