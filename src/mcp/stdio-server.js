import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './tools.js';

/**
 * stdio transport, for agents that spawn the server themselves
 * (e.g. `claude mcp add pamssh -- npx -y pamssh-mcp stdio`).
 * SSH sessions then live as long as that agent process.
 */
export async function startStdioServer({ manager, logger }) {
  const server = createMcpServer(manager, { logger });
  const transport = new StdioServerTransport();
  // Must be set before connect(): Protocol.connect() chains onto it.
  const closed = new Promise((resolve) => { server.server.onclose = resolve; });
  await server.connect(transport);
  return { close: () => server.close(), closed };
}
