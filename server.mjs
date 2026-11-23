import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";
import { resolveTimeoutMs, triageText } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const clientScript = await readFile(new URL("./client-state.mjs", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readPayload(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function handleTriage(request, response, options) {
  let payload;
  try {
    payload = await readPayload(request);
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(response, 400, { status: "invalid_input" });
  }
  const result = await triageText(payload.text, options);
  return json(response, result.httpStatus, result.body);
}

export function createApp({ classifyFn = classify, timeoutMs = resolveTimeoutMs() } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/client-state.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(clientScript);
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classifyFn, timeoutMs });
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1");
}
