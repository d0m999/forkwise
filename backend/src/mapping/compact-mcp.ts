import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiTransport } from '../mcp-server.js';
import { ObserveQuerySchema } from './observe-contracts.js';
import { TagCommandSchema } from './contracts.js';

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
        '只读同步开放地图有序变化。afterRevision 是已完整读取的修订；首批 baseSnapshot 校验缓存，续页 snapshot 固定终点。整批连续后用返回 snapshot 重读 index/detail。RESET_REQUIRED 全量重读；过期重启重新开始；授权错误重新取得授权后完整读取。budget 为完整 Mapping JSON 的 UTF-8 字节，limit 至多100；协议外壳不计入。',
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
        return {
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : '地图同步失败',
            },
          ],
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    'forkwise_read_map',
    {
      description:
        '读取本机开放地图。先 index，再以原 snapshot 选卡读 body/detail；budget 为完整 Mapping JSON 的 UTF-8 字节，summary 不推断未读正文。',
      inputSchema: z
        .object({
          projectId: z.string().min(1).max(160),
          view: z.enum(['index', 'body', 'detail', 'tags']),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : '地图读取失败',
            },
          ],
          isError: true,
        };
      }
    },
  );
}
