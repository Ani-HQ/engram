#!/usr/bin/env node

/**
 * @ani-hq/engram-mcp — stdio MCP proxy to engram's HTTP /mcp surface.
 *
 * Env:
 *   ENGRAM_HOST   — base URL (required)
 *   ENGRAM_TOKEN  — bearer token (required)
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const HOST = (process.env.ENGRAM_HOST || '').replace(/\/$/, '');
const TOKEN = process.env.ENGRAM_TOKEN || '';

if (!HOST || !TOKEN) {
  console.error(
    '@ani-hq/engram-mcp requires ENGRAM_HOST and ENGRAM_TOKEN environment variables'
  );
  process.exit(1);
}

let rpcId = 1;

async function engramRpc(method, params) {
  const body = {
    jsonrpc: '2.0',
    id: rpcId++,
    method,
  };
  if (params !== undefined) body.params = params;

  const res = await fetch(`${HOST}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || json.error || `engram MCP HTTP ${res.status}`);
  }
  if (json.error) {
    throw new Error(json.error.message || `engram MCP error ${json.error.code}`);
  }
  return json.result;
}

async function main() {
  const server = new Server(
    { name: 'engram', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await engramRpc('tools/list');
    return {
      tools: (result.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await engramRpc('tools/call', {
      name: request.params.name,
      arguments: request.params.arguments || {},
    });

    if (result?.content) {
      return result.isError ? { content: result.content, isError: true } : { content: result.content };
    }
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
