import type { Card } from './contracts.js';
import type { CompactQuery } from './compact-contracts.js';
import type { SearchQuery, SearchStateQuery } from './search-contracts.js';

export const versionDomains = ['body', 'pose', 'appearance', 'tag', 'cardTags', 'attachments', 'shape', 'stroke', 'image', 'connector', 'group', 'containment', 'frame'] as const;

export type VersionQuery = {
  type: 'version';
  projectId: string;
  domain: (typeof versionDomains)[number];
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
  | { type: 'cut.state'; projectId: string; cutId: string }
  | { type: 'projects' }
  | { type: 'project'; projectId: string }
  | VersionQuery;
