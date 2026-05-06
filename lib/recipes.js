import { z } from 'zod';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('remove-attr'),    selector: z.string().min(1), attr:  z.string().min(1) }),
  z.object({ action: z.literal('remove-class'),   selector: z.string().min(1), class: z.string().min(1) }),
  z.object({ action: z.literal('remove-element'), selector: z.string().min(1) }),
  z.object({ action: z.literal('unwrap'),         selector: z.string().min(1) }),
]);

const FetchSchema = z.object({
  render:          z.enum(['force', 'skip']).optional(),
  wait_for:        z.string().min(1).optional(),
  wait_timeout_ms: z.number().int().min(0).max(15000).optional(),
  mobile_ua:       z.boolean().optional(),
}).strict();

const SelectSchema = z.object({
  remove: z.array(z.string().min(1)).default([]),
}).strict();

export const RecipeSchema = z.object({
  name:       z.string().min(1),
  host:       z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  path:       z.string().min(1).default('/**'),
  preprocess: z.array(ActionSchema).default([]),
  select:     SelectSchema.default({ remove: [] }),
  extractor:  z.enum(['readability', 'trafilatura', 'playwright']).optional(),
  fetch:      FetchSchema.default({}),
}).strict();
