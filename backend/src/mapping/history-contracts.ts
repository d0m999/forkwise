import type { Change } from './contracts.js';
export interface HistoryAction {
  deletedCardIds?: string[];
  id: string;
  label: string;
  target: { id: string; title: string };
  actor: Change['actor'];
}
export interface ProjectHistory {
  revision: number;
  undo: HistoryAction[];
  redo: HistoryAction[];
}
