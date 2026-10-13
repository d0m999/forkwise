import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiTransport } from '../mcp-server.js';

// The tool is read-only. Authentication and snapshots live in Mapping, not MCP.
export function registerCompactMapTool(server: McpServer, transport: ApiTransport) {
  server.registerTool(
    'forkwise_read_map',
    {
      description:
        '读取本机开放地图。先 index，再以原 snapshot 选卡读 body/detail；budget 为完整 Mapping JSON 的 UTF-8 字节，summary 不推断未读正文。',
      inputSchema: z
        .object({
          projectId: z.string().min(1).max(160),
          view: z.enum(['index', 'body', 'detail']),
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
