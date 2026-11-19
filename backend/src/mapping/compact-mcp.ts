import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiTransport } from '../mcp-server.js';
import { ApiTransportError } from '../api-transport-error.js';
import { ObserveQuerySchema } from './observe-contracts.js';
import { BodyPatchCommand, BodyPatchPayload, MAX_AGENT_BATCH_POSES, TagCommandSchema } from './contracts.js';

function readError(error: unknown, fallback: string) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : fallback }],
    ...(error instanceof ApiTransportError ? { structuredContent: { error: error.response } } : {}),
    isError: true,
  };
}

// The tool is read-only. Authentication and snapshots live in Mapping, not MCP.
export function registerCompactMapTool(server: McpServer, transport: ApiTransport) {
  server.registerTool('forkwise_execute_tag_command', {
    description: '在明确项目编辑委托内管理项目标签与单卡关联顺序。与本人界面共用Mapping事务、细域expected、持久commandId和统一历史；删除须先完整读取当前标签和全部受影响cardTags版本并确认。Agent不能撤销研究历史。',
    inputSchema: z.object({ command: TagCommandSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ command }) => {
    try {
      const response = await transport.call('/api/mapping/execute', 'POST', command);
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: { response } };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '标签保存失败' }], isError: true };
    }
  });
  server.registerTool(
    'forkwise_read_asset',
    {
      description:'明确读取当前授权项目内不可变媒体原件的完整JSON（含base64与摘要）；普通地图读取不会自动展开媒体字节。资源身份不可改写，仍需每次验证项目权限。',
      inputSchema:z.object({projectId:z.string().min(1).max(160),id:z.string().min(1).max(160)}).strict(),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
    async({projectId,id})=>{
      try {
        const response=await transport.call(`/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(id)}`);
        return {content:[{type:'text' as const,text:JSON.stringify(response)}],structuredContent:{response}};
      }catch(error){return {content:[{type:'text' as const,text:error instanceof Error?error.message:'媒体读取失败'}],isError:true};}
    },
  );
  server.registerTool(
    'forkwise_observe_map',
    {
      description:
        '只读同步开放地图有序变化。afterRevision 是已完整读取的修订；首批 baseSnapshot 校验缓存，续页 snapshot 固定终点。整批连续后或 RESET_REQUIRED 时，使用返回的 snapshot 读取十一个视图 index、tags、text-index、shape-index、stroke-index、image-index、connector-index、group-index、frame-index、containment、attachment-index，每个视图读至 complete，再按需读取各对象完整 detail。根 index 仅含 Card。预算错误保留 error.details.recovery，按其中 snapshot 完整重读；过期重启重新开始；授权错误重新取得授权。budget 为完整 Mapping JSON 的 UTF-8 字节，limit 至多100；协议外壳不计入。',
      inputSchema: ObserveQuerySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, afterRevision, ...query }) => {
      try {
        const parameters = new URLSearchParams({ after: String(afterRevision) });
        for (const [key, value] of Object.entries(query))
          if (value !== undefined) parameters.set(key, String(value));
        const page = await transport.call(
          `/api/mapping/projects/${encodeURIComponent(projectId)}/changes?${parameters}`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(page) }],
          structuredContent: { response: page },
        };
      } catch (error) {
        return readError(error, '地图同步失败');
      }
    },
  );
  server.registerTool(
    'forkwise_read_map',
    {
      description:
        '读取本机开放地图。根 index 仅含 Card；完整读取须在同一 snapshot 分别读取 index、tags、text-index、shape-index、stroke-index、image-index、connector-index、group-index、frame-index、containment、attachment-index 十一个视图，每个视图分页至 complete。按需选卡读 body/detail，或按 textId、shapeId、strokeId、imageId、connectorId 读取 text-detail、shape-detail、stroke-detail、image-detail、connector-detail；完整详情与索引须同 snapshot。图片详情包含固定assetId与裁剪，姿态在索引，原件另由read_asset明确读取；无OCR或远程抓取。附着索引给出批注 itemId 与目标卡片 itemId。budget 为完整 Mapping JSON 的 UTF-8 字节，summary 不推断未读内容。',
      inputSchema: z
        .object({
          projectId: z.string().min(1).max(160),
          view: z.enum(['index', 'body', 'detail', 'tags', 'text-index', 'text-detail', 'shape-index', 'shape-detail', 'stroke-index', 'stroke-detail', 'image-index', 'image-detail', 'connector-index', 'connector-detail', 'group-index', 'frame-index', 'containment', 'attachment-index']),
          connectorId: z.string().min(1).max(160).optional(),
          imageId: z.string().min(1).max(160).optional(),
          strokeId: z.string().min(1).max(160).optional(),
          shapeId: z.string().min(1).max(160).optional(),
          textId: z.string().min(1).max(160).optional(),
          cardId: z.string().min(1).max(160).optional(),
          snapshot: z.string().uuid().optional(),
          cursor: z.string().min(1).max(2048).optional(),
          budget: z.number().int().positive().max(1_048_576).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, ...query }) => {
      try {
        const parameters = new URLSearchParams();
        for (const [key, value] of Object.entries(query))
          if (value !== undefined) parameters.set(key, String(value));
        const page = await transport.call(
          `/api/mapping/projects/${encodeURIComponent(projectId)}/map?${parameters}`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(page) }],
          structuredContent: { response: page },
        };
      } catch (error) {
        return readError(error, '地图读取失败');
      }
    },
  );
  server.registerTool(
    'forkwise_read_mapping_history',
    {
      description:
        '只读当前授权项目的 Mapping 项目历史（undo/redo 两个栈，按项目时间顺序）。这是开放地图历史，与旧研究 action-history 工具无关；Agent 只能读取，不能撤销或重做。',
      inputSchema: z.object({ projectId: z.string().min(1).max(160) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId }) => {
      try {
        const page = await transport.call(
          `/api/mapping/projects/${encodeURIComponent(projectId)}/history`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(page) }],
          structuredContent: { response: page },
        };
      } catch (error) {
        return readError(error, '历史读取失败');
      }
    },
  );
  server.registerTool(
    'forkwise_patch_card_body',
    {
      description:
        '仅限已授权块区间，不写布局/标题/外观。先读取该卡片完整正文块与 body.versionId，再提交单块内 [start, end) 范围的 JS UTF-16 code unit 偏移。冲突时请重读。以原 commandId 重试同一请求可取回原回执。',
      inputSchema: BodyPatchCommand.omit({ type: true, payload: true }).extend({
        cardId: BodyPatchPayload.shape.id,
        blockId: BodyPatchPayload.shape.blockId,
        range: BodyPatchPayload.shape.range,
        text: BodyPatchPayload.shape.text,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, commandId, expected, cardId, blockId, range, text }) => {
      try {
        const response = await transport.call('/api/mapping/execute', 'POST', {
          projectId, commandId, expected, type: 'body.patch',
          payload: { id: cardId, blockId, range, text },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          structuredContent: { response },
        };
      } catch (error) {
        return readError(error, '正文补丁保存失败');
      }
    },
  );
  server.registerTool(
    'forkwise_move_card',
    {
      description:
        '在明确的项目布局委托内移动一张已有卡片到绝对坐标。先读取 index 取得该卡的 item.versionId 与当前 Pose，将版本作为 expected 提交；与本人界面共用同一 execute、项目 revision、历史与持久 commandId 回执。只写 x/y，不写正文、标题、外观、标签或归属。',
      inputSchema: z
        .object({
          projectId: z.string().min(1).max(160),
          commandId: z.string().min(8).max(160),
          cardId: z.string().min(1).max(160),
          expected: z.string().min(1).max(160),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, commandId, cardId, expected, x, y }) => {
      try {
        const response = await transport.call('/api/mapping/execute', 'POST', {
          commandId,
          projectId,
          type: 'pose.move',
          expected,
          payload: { id: cardId, x, y },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          structuredContent: { response },
        };
      } catch (error) {
        return readError(error, '布局保存失败');
      }
    },
  );
  server.registerTool(
    'forkwise_move_cards',
    {
      description:
        '在明确的项目布局委托内批量移动已有卡片。每张卡都要给出当前 Pose 版本与目标 x/y/width/height；任何一个目标无权限、已删除、版本过期或字段超范围时整批拒绝，不产生部分移动。与本人界面共用同一 execute。',
      inputSchema: z
        .object({
          projectId: z.string().min(1).max(160),
          commandId: z.string().min(8).max(160),
          expected: z.record(z.string().min(1).max(160), z.string().min(1).max(160)),
          poses: z
            .array(
              z
                .object({
                  cardId: z.string().min(1).max(160),
                  x: z.number().finite(),
                  y: z.number().finite(),
                  width: z.number().finite().positive(),
                  height: z.number().finite().positive(),
                })
                .strict(),
            )
            .min(1)
            .max(MAX_AGENT_BATCH_POSES),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, commandId, expected, poses }) => {
      try {
        const response = await transport.call('/api/mapping/execute', 'POST', {
          commandId,
          projectId,
          type: 'pose.batch',
          expected,
          payload: {
            poses: poses.map((pose) => ({
              id: pose.cardId,
              x: pose.x,
              y: pose.y,
              width: pose.width,
              height: pose.height,
            })),
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          structuredContent: { response },
        };
      } catch (error) {
        return readError(error, '批量布局保存失败');
      }
    },
  );
}
