import { z } from 'zod';

const uuid = z.string().uuid();

export const createWebReportSchema = z.object({
  body: z.object({
    url: z.string().trim().min(1).max(2048),
    maxPages: z.number().int().min(1).max(200).optional(),
    force: z.boolean().optional().default(false),
  }),
  query: z.object({}).optional().default({}),
  params: z.object({}).optional().default({}),
});

export const listWebReportsSchema = z.object({
  body: z.object({}).optional().default({}),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  }),
  params: z.object({}).optional().default({}),
});

export const reportIdSchema = z.object({
  body: z.object({}).optional().default({}),
  query: z.object({}).optional().default({}),
  params: z.object({ id: uuid }),
});

export const rescanSchema = z.object({
  body: z.object({
    maxPages: z.number().int().min(1).max(200).optional(),
  }).optional().default({}),
  query: z.object({}).optional().default({}),
  params: z.object({ id: uuid }),
});

export const shareTokenSchema = z.object({
  body: z.object({}).optional().default({}),
  query: z.object({}).optional().default({}),
  params: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }),
});

export const updateBrandingSchema = z.object({
  body: z.object({
    companyName: z.string().trim().max(200).nullable().optional(),
    logoUrl: z.string().trim().url().max(2048).nullable().optional(),
  }),
  query: z.object({}).optional().default({}),
  params: z.object({ id: uuid }),
});
