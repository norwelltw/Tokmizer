import { z } from "zod";

export const FilterDef = z.object({
  slug: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  match_command: z.string().min(1),
  priority: z.number().int().default(50),
  strip_ansi: z.boolean().default(false),
  strip_lines_matching: z.array(z.string()).default([]),
  keep_failures: z.boolean().default(false),
  strip_on_failure: z.boolean().default(false),
  fold_passing: z.boolean().default(false),
  fold_passing_threshold: z.number().int().positive().max(1000).optional(),
  mask_abs_paths: z.boolean().default(false),
  preserve_exact: z.boolean().default(false),
  truncate_lines_at: z.number().int().positive().max(10000).optional(),
  max_lines: z.number().int().positive().max(100000).optional(),
  scale_with_level: z.boolean().default(true),
  transform: z.string().max(64).optional(),
  on_empty: z.string().max(255).optional()
});

export type FilterDef = z.infer<typeof FilterDef>;

