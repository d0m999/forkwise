import { z } from 'zod';

const Id = z.string().min(1).max(160);
const PathMode = z.enum(['straight', 'elbow', 'curve']);
const Marker = z.enum(['none', 'open-arrow', 'triangle', 'dot', 'diamond']);
const Style = z.object({ startMarker: Marker, endMarker: Marker,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), width: z.number().finite().positive(),
  dash: z.enum(['solid', 'dashed']),
}).strict();
export type ConnectorStyle = z.infer<typeof Style>;
const Label = z.object({ text: z.string(), position: z.number().finite().min(0).max(1),
  fontSize: z.number().finite().positive(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), bold: z.boolean(),
}).strict();
export type ConnectorLabel = z.infer<typeof Label>;
export const DEFAULT_CONNECTOR_STYLE: Readonly<ConnectorStyle> = Object.freeze({
  startMarker: 'none', endMarker: 'open-arrow', color: '#626e81', width: 4, dash: 'solid',
});
const FreeEndpoint = z.object({
  kind: z.literal('free'),
  point: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
}).strict();
const BoundEndpoint = z.object({
  kind: z.literal('bound'),
  itemId: Id,
  side: z.enum(['top', 'right', 'bottom', 'left']),
}).strict();
const Endpoint = z.discriminatedUnion('kind', [FreeEndpoint, BoundEndpoint]);
export type ConnectorEndpoint = z.infer<typeof Endpoint>;
export const ConnectorCreateCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('connector.create'),
  expected: z.null(),
  payload: z.object({
    id: Id,
    start: Endpoint,
    end: Endpoint,
    path: PathMode.default('straight'),
  }).strict(),
}).strict();
export const ConnectorReconnectCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('connector.reconnect'),
  expected: Id,
  payload: z.object({ id: Id, endpoint: z.enum(['start', 'end']), value: Endpoint }).strict(),
}).strict();
export const ConnectorPathCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('connector.path'),
  expected: Id,
  payload: z.object({ id: Id, path: PathMode }).strict(),
}).strict();
export const ConnectorMoveCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('connector.move'),
  expected: Id,
  payload: z.object({ id: Id, dx: z.number().finite(), dy: z.number().finite() }).strict(),
}).strict();
export const ConnectorStyleCommand = z.object({
  commandId: Id, projectId: Id, type: z.literal('connector.style'), expected: Id,
  payload: z.object({ id: Id, style: Style.partial() }).strict(),
}).strict();
export const ConnectorReverseCommand = z.object({
  commandId: Id, projectId: Id, type: z.literal('connector.reverse'), expected: z.record(Id, Id),
  payload: z.object({ ids: z.array(Id).min(1).refine(ids => new Set(ids).size === ids.length) }).strict(),
}).strict();
export const ConnectorLabelCommand = z.object({
  commandId: Id, projectId: Id, type: z.literal('connector.label'), expected: Id,
  editGroup: Id.optional(),
  payload: z.object({ id: Id, label: Label.nullable() }).strict(),
}).strict();
export const ConnectorDeleteCommand = z.object({
  commandId: Id,
  projectId: Id,
  type: z.literal('connector.delete'),
  expected: Id,
  payload: z.object({ id: Id }).strict(),
}).strict();
export const ConnectorCommands = z.discriminatedUnion('type', [
  ConnectorCreateCommand,
  ConnectorReconnectCommand,
  ConnectorPathCommand,
  ConnectorMoveCommand,
  ConnectorStyleCommand,
  ConnectorReverseCommand,
  ConnectorLabelCommand,
  ConnectorDeleteCommand,
]);
export type ConnectorCommand = z.infer<typeof ConnectorCommands>;
export interface CanvasConnector {
  id: string;
  kind: 'connector';
  versionId: string;
  path: z.infer<typeof PathMode>;
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  style?: ConnectorStyle;
  label?: ConnectorLabel | null;
}
export type ConnectorChange = { before: CanvasConnector | null; after: CanvasConnector | null };
