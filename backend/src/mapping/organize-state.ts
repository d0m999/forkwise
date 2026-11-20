import type { OrganizeTask } from './organize-contracts.js';

export function canRetryOrganize(task: Pick<OrganizeTask, 'state' | 'applied'>): boolean {
  return !task.applied && ['failed', 'partial', 'cancelled', 'interrupted'].includes(task.state);
}
