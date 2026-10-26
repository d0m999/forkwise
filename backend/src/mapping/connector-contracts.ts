import { z } from 'zod';

const Id = z.string().min(1).max(160);
const PathMode = z.enum(['straight', 'elbow', 'curve']);
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
}
export type ConnectorChange = { before: CanvasConnector | null; after: CanvasConnector | null };
