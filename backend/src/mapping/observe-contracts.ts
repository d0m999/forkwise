import { z } from 'zod';
import type { Change } from './contracts.js';

export const ObserveQuerySchema = z
  .object({
    projectId: z.string().min(1).max(160),
    afterRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    snapshot: z.string().uuid().optional(),
    baseSnapshot: z.string().uuid().optional(),
    limit: z.number().int().positive().max(100).default(100),
    budget: z.number().int().positive().max(1_048_576).default(131_072),
  })
  .strict();
export type ObserveQuery = z.input<typeof ObserveQuerySchema>;
export interface Delta extends Change {
  domains: { domain: 'project' | 'thought' | 'body' | 'pose' | 'appearance'; id: string }[];
  deletedIds: string[];
}
export interface ObservePage {
  status: 'OK' | 'RESET_REQUIRED';
  reason?: 'CURSOR_TOO_OLD' | 'CURSOR_AHEAD' | 'CHANGE_GAP';
  recovery?: { type: 'map'; view: 'index'; projectId: string; snapshot: string };
  projectId: string;
  revision: number;
  afterRevision: number;
  nextRevision: number;
  complete: boolean;
  snapshot: string;
  expiresAt: number;
  budgetUnit: 'utf8_bytes';
  bytes: number;
  changes: Delta[];
}
