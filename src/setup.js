import {fileURLToPath} from 'node:url';

export const mcpPath = fileURLToPath(new URL('./mcp-server.js', import.meta.url));

export async function integrationStatus(client, dataDir) {
  const result = await client.request('config/read', {includeLayers: false});
  const entry = result.config?.mcp_servers?.serein;
  if (!entry) return 'missing';
  if (!Array.isArray(entry.args) || !entry.args.includes(mcpPath)) return 'conflict';
  if (entry.env?.SEREIN_HOME !== dataDir || (entry.env?.SEREIN_CODEX_SOCKET || '') !== (process.env.SEREIN_CODEX_SOCKET || '') || entry.default_tools_approval_mode !== 'approve') return 'needs-update';
  return 'ready';
}

// Explicitly invoked by the user from the console or `serein setup`.
export async function setupIntegration(client, dataDir) {
  const status = await integrationStatus(client, dataDir);
  if (status === 'conflict') throw new Error('A different MCP server named serein already exists. Check ~/.codex/config.toml.');
  const entries = [
    ['mcp_servers.serein.command', process.execPath],
    ['mcp_servers.serein.args', ['--disable-warning=ExperimentalWarning', mcpPath]],
    ['mcp_servers.serein.env.SEREIN_HOME', dataDir],
    ['mcp_servers.serein.env.SEREIN_CODEX_SOCKET', process.env.SEREIN_CODEX_SOCKET || ''],
    ['mcp_servers.serein.default_tools_approval_mode', 'approve'],
  ];
  await client.request('config/batchWrite', {edits: entries.map(([keyPath, value]) => ({keyPath, value, mergeStrategy: 'upsert'}))});
  await client.request('config/mcpServer/reload');
}
