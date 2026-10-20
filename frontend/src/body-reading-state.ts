import type { Block } from '../../backend/src/mapping/contracts';
import { listEnd } from '../../backend/src/mapping/list-structure';

export function foldEnd(blocks: Block[], index: number): number {
  const block = blocks[index];
  if (block?.type !== 'heading') return listEnd(blocks, index);
  let end = index + 1;
  while (end < blocks.length) {
    const next = blocks[end]!;
    if (next.type === 'heading' && Number(next.level) <= Number(block.level)) break;
    end++;
  }
  return end;
}

// Reading preferences never enter the Body command, draft journal, or history.
export class BodyReadingState {
  private preferences = new Set<string>();
  readonly temporary = new Set<string>();
  private searchExpanded = new Set<string>();
  private deferred = new Set<string>();
  readonly key: string;
  constructor(
    identity: string,
    private storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  ) {
    this.key = `forkwise:body-folds:v1:${identity}`;
    this.refreshPreferences();
  }
  refreshPreferences(): void {
    try {
      const saved: unknown = JSON.parse(this.storage.getItem(this.key) ?? '[]');
      if (Array.isArray(saved))
        this.preferences = new Set(saved.filter((id): id is string => typeof id === 'string'));
    } catch {
      /* An unreadable preference must never prevent reading the Body. */
    }
  }
  collapsed(id: string): boolean {
    return (
      this.preferences.has(id) &&
      !this.temporary.has(id) &&
      !this.searchExpanded.has(id) &&
      !this.deferred.has(id)
    );
  }
  toggle(id: string): void {
    const collapse = !this.collapsed(id);
    this.temporary.delete(id);
    this.searchExpanded.delete(id);
    this.deferred.delete(id);
    if (collapse) this.preferences.add(id);
    else this.preferences.delete(id);
    this.storage.setItem(this.key, JSON.stringify([...this.preferences]));
    window.dispatchEvent(new CustomEvent("forkwise-fold-preference", { detail: this.key }));
  }
  hidden(blocks: Block[]): Set<string> {
    const hidden = new Set<string>();
    blocks.forEach((b, i) => {
      if (this.collapsed(b.id))
        for (let j = i + 1; j < foldEnd(blocks, i); j++) hidden.add(blocks[j]!.id);
    });
    return hidden;
  }
  reveal(blocks: Block[], ids: readonly string[]): void {
    for (const id of this.ancestors(blocks, ids)) this.temporary.add(id);
  }
  private ancestors(blocks: Block[], ids: readonly string[]): Set<string> {
    const targets = new Set(ids);
    const ancestors = new Set<string>();
    blocks.forEach((block, i) => {
      if (blocks.slice(i + 1, foldEnd(blocks, i)).some((b) => targets.has(b.id)))
        ancestors.add(block.id);
    });
    return ancestors;
  }
  beginSearch(blocks: Block[], hitIds: readonly string[]): void {
    this.searchExpanded = this.ancestors(blocks, hitIds);
  }
  endSearch(blocks: Block[], editingId?: string): void {
    const editingAncestors = this.ancestors(blocks, editingId ? [editingId] : []);
    this.deferred = new Set([...this.searchExpanded].filter((id) => editingAncestors.has(id)));
    this.searchExpanded.clear();
  }
  leaveEditing(): void {
    this.deferred.clear();
  }
}
