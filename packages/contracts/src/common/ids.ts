import { z } from 'zod';

export const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid ID format');
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
