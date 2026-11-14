import { z } from 'zod';

export const currencyEnum = z.enum(['BCV_USD', 'BCV_EUR', 'YD_USD']);

export const currencyParamSchema = z.object({
  currency: currencyEnum,
});

export const ratesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  days: z.coerce.number().int().min(1).max(365).optional(),
  currency: currencyEnum.optional(),
});

export const currencyHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export const syncQuerySchema = z.object({
  source: z.enum(['all', 'bcv', 'yadio']).default('all'),
});
