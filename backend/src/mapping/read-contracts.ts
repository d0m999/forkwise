import type { Card } from './contracts.js';
import type { CompactQuery } from './compact-contracts.js';
import type { SearchQuery, SearchStateQuery } from './search-contracts.js';

export type VersionQuery = {
  type: 'version';
  projectId: string;
  domain: 'body' | 'pose' | 'appearance' | 'tag' | 'cardTags' | 'shape' | 'stroke' | 'image' | 'connector' | 'group' | 'containment';
  id: string;
  versionId: string;
};
export type CardIdentity =
  | { availability: 'available'; card: Card }
  | { availability: 'deleted' | 'not_found' };
export type IdentityQuery = { type: 'card.identity'; projectId: string; id: string };
export type AssetQuery = { type:'asset'; projectId:string; id:string };
export type ReadQuery =
  | SearchStateQuery
  | SearchQuery
  | AssetQuery
  | CompactQuery
  | IdentityQuery
  | { type: 'history'; projectId: string }
  | { type: 'projects' }
  | { type: 'project'; projectId: string }
  | VersionQuery;
