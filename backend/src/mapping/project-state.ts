import type Database from 'better-sqlite3';
import { readAttachments } from './attachment.js';
import { readConnectors } from './connector.js';
import type { Card, Project, ProjectState } from './contracts.js';
import { readFrames } from './frame.js';
import { readContainment, readGroups } from './group.js';
import { readImages } from './image.js';
import { readShapes } from './shape.js';
import { readStrokes } from './stroke.js';
import { readTags } from './tags.js';
import { readTexts } from './text.js';

export function readProjectState(db: Database.Database, project: Project): ProjectState {
  const cards = (db.prepare(
    'SELECT c.value FROM mapping_cards c JOIN mapping_card_ids i ON i.id=c.id WHERE c.project_id=? ORDER BY i.rowid',
  ).all(project.id) as { value: string }[]).map(row => JSON.parse(row.value) as Card);
  return {
    project,
    cards,
    frames: readFrames(db, project.id),
    groups: readGroups(db, project.id),
    containment: readContainment(db, project.id),
    attachments: readAttachments(db, project.id),
    connectors: readConnectors(db, project.id),
    images: readImages(db, project.id),
    tags: readTags(db, project.id),
    texts: readTexts(db, project.id),
    shapes: readShapes(db, project.id),
    strokes: readStrokes(db, project.id),
  };
}
