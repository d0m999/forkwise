import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, httpTransport } from './mcp-server.js';

const token = process.env.FORKWISE_AGENT_TOKEN;
if (!token) throw new Error('请在见岔中为 Agent 授权项目，并设置 FORKWISE_AGENT_TOKEN');
const server = createMcpServer(
  httpTransport(process.env.FORKWISE_URL ?? 'http://127.0.0.1:8787', token),
);
await server.connect(new StdioServerTransport());
