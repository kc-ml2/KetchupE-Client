import { z } from "zod";

const nullableString = z.string().nullable().optional();
export const browseStorageArguments = z.object({
  storage_id: nullableString,
  path: z.string().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  max_results: z.number().int().positive().optional(),
}).strict();
export const findStorageArguments = z.object({
  query: nullableString,
  storage_id: nullableString,
  file_path: nullableString,
  extensions: z.array(z.string()).nullable().optional(),
  modified_from: nullableString,
  modified_before: nullableString,
  min_size_bytes: z.number().int().nonnegative().nullable().optional(),
  max_size_bytes: z.number().int().nonnegative().nullable().optional(),
  search_in: z.enum(["filename", "content", "both"]).optional(),
  path: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  include_globs: z.array(z.string()).nullable().optional(),
  exclude_globs: z.array(z.string()).nullable().optional(),
  max_results: z.number().int().positive().optional(),
}).strict();

