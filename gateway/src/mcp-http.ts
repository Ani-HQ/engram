const HINT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram MCP</title>
<style>
  body { font: 16px/1.4 ui-sans-serif, system-ui; background: #111; color: #f4f1ea; margin: 0; }
  main { max-width: 32rem; margin: 12vh auto; padding: 0 1.25rem; }
  code { background: #222; padding: 0.15rem 0.35rem; }
</style></head>
<body><main>
  <h1>engram</h1>
  <p>This URL is the MCP endpoint. A browser GET cannot talk to it.</p>
  <p>Paste <code>https://engram.ani.computer/mcp</code> into a ChatGPT, Claude, or Grok custom connector. Sign in with the same email as the console.</p>
  <p>Cursor and Claude Code still send <code>Authorization: Bearer</code> on POST.</p>
</main></body></html>`;

export function mcpMethodNotAllowed(req: Request): Response {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return new Response(HINT, {
      status: 405,
      headers: {
        Allow: "POST",
        "content-type": "text/html; charset=utf-8",
      },
    });
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
