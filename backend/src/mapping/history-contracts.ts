import type { Change } from './contracts.js';
export interface HistoryAction {
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
