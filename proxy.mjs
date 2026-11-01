import http from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveKey, credentialSourceId } from "./env.mjs";
import { MAX_REQUEST_BODY_BYTES, MAX_REQUEST_IMAGES } from "./request-budget.mjs";
export { MAX_REQUEST_BODY_BYTES, MAX_REQUEST_IMAGES } from "./request-budget.mjs";

export const VERSION = "1.1.0";
export const PROXY_PORT = Number(process.env.MISTRAL_BRIDGE_PORT || 8791);
if (!Number.isInteger(PROXY_PORT) || PROXY_PORT < 1 || PROXY_PORT > 65535) throw new Error("Invalid MISTRAL_BRIDGE_PORT");
// Fingerprint every file that changes request behaviour so a daemon from an
// older build is never silently reused.
export const CORE_SHA256 = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL("./env.mjs", import.meta.url)))
  .update(readFileSync(new URL("./request-budget.mjs", import.meta.url)))
  .update(readFileSync(new URL("./zcode-source.mjs", import.meta.url)))
  .update(readFileSync(new URL("./ownership.mjs", import.meta.url)))
  .update(readFileSync(new URL("./daemon.mjs", import.meta.url)))
  .digest("hex");

function splitContent(content) {
  let thinking = "", text = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    else if (block?.type === "thinking" && Array.isArray(block.thinking)) {
      for (const part of block.thinking) {
        if (part?.type !== "text" || typeof part.text !== "string") throw new Error("unsupported_thinking_block");
        thinking += part.text;
      }
    } else throw new Error("unsupported_content_block");
  }
  return { thinking, text };
}

export function rewriteResponse(body) {
  for (const choice of body?.choices || []) {
    const message = choice.delta || choice.message;
    if (!message) continue;
    if (Array.isArray(message.content)) {
      const { thinking, text } = splitContent(message.content);
      message.content = text;
      if (thinking) message.reasoning_content = (message.reasoning_content || "") + thinking;
    }
    // Mistral's schema allows object arguments; ZCode's compatible client expects strings.
    for (const call of message.tool_calls || []) {
      if (call.function?.arguments && typeof call.function.arguments === "object") {
        call.function.arguments = JSON.stringify(call.function.arguments);
      }
    }
  }
  return body;
}

export function rewriteRequest(body) {
  // pi-ai's DeepSeek dialect enables reasoning with this extra top-level
  // switch. Mistral accepts reasoning_effort and rejects the thinking field.
  // Assistant thinking content blocks remain part of message history.
  if (body?.thinking && ["enabled", "disabled"].includes(body.thinking.type)) delete body.thinking;
  for (const message of body?.messages || []) {
    if (message.role !== "assistant") continue;
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      const content = message.content;
      const blocks = Array.isArray(content) ? content :
        typeof content === "string" && content ? [{ type: "text", text: content }] : [];
      // Preserve already structured messages without duplicating thinking.
      if (!blocks.some(b => b?.type === "thinking")) {
        message.content = [{ type: "thinking", thinking: [{ type: "text", text: reasoning }] }, ...blocks];
      }
    }
    delete message.reasoning_content;
    delete message.reasoning;
  }
  return body;
}

/**
 * Replace the oldest images beyond Mistral's per-request image count with a
 * text note, so long screenshot sessions keep working. History is untouched;
 * only this request changes. Returns the number of images omitted.
 */
export function limitRequestImages(body, max = MAX_REQUEST_IMAGES) {
  const images = [];
  for (const message of body?.messages || []) {
    if (!Array.isArray(message.content)) continue;
    message.content.forEach((block, index) => { if (block?.type === "image_url") images.push({ message, index }); });
  }
  const omitted = Math.max(0, images.length - max);
  for (const { message, index } of images.slice(0, omitted)) {
    message.content[index] = { type: "text", text: `[Older image omitted from this request: Mistral accepts at most ${max} images per request. Re-read the file if it is still needed.]` };
  }
  return omitted;
}

// Decode across byte boundaries and dispatch complete SSE events, including CRLF
// and multiline data fields. Never fabricate completion after a truncated stream.
export async function* transformSse(body, touch = () => {}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", lines = [], done = false;
  const seen = new Set(), finished = new Set();
  function event() {
    const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, ""));
    const other = lines.filter(l => !l.startsWith("data:"));
    lines = [];
    if (!data.length) return other.length ? other.join("\n") + "\n\n" : "";
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      if (!seen.size || [...seen].some(i => !finished.has(i))) throw new Error("missing_finish_reason");
      done = true;
      return "data: [DONE]\n\n";
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { throw new Error("invalid_sse_json"); }
    if (chunk.error) throw new Error("upstream_stream_error");
    for (const choice of chunk.choices || []) {
      const index = choice.index ?? 0;
      seen.add(index);
      if (choice.finish_reason != null) finished.add(index);
    }
    return [...other, `data: ${JSON.stringify(rewriteResponse(chunk))}`, "", ""].join("\n");
  }
  function* drain(final = false) {
    while (buffer.length) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line) lines.push(line); else {
        const out = event();
        if (out) yield out;
        if (done) return;
      }
    }
    if (buffer.length > 8 * 1024 * 1024 || lines.reduce((n, l) => n + l.length, 0) > 8 * 1024 * 1024) {
      throw new Error("sse_event_too_large");
    }
  }
  for await (const bytes of body) {
    touch();
    buffer += decoder.decode(bytes, { stream: true });
    yield* drain();
    if (done) return;
  }
  buffer += decoder.decode();
  yield* drain(true);
  if (!done) throw new Error("upstream_stream_incomplete");
}

function headersWithoutHopByHop(input) {
  const headers = Object.fromEntries(input instanceof Headers ? input.entries() : Object.entries(input));
  const extra = String(headers.connection || "").split(",").map(s => s.trim().toLowerCase());
  for (const key of ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", ...extra]) delete headers[key];
  return headers;
}

// Loopback binding alone does not stop browser DNS rebinding. Native host
// clients omit Origin; browser requests must originate at this listener.
function localRequest(req) {
  const port = req.socket.localPort;
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) { authorities.add("127.0.0.1"); authorities.add("localhost"); }
  if (!authorities.has(String(req.headers.host || "").toLowerCase())) return false;
  if (req.headers.origin === undefined) return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.protocol === "http:" && authorities.has(origin.host.toLowerCase())
      && req.headers.origin === origin.origin;
  } catch { return false; }
}

// Brief transparent retries before any response byte reaches the client.
// Longer outages are left to the host's own retry policy.
export const PRE_STREAM_RETRY_DELAYS_MS = [1000, 3000];
const RETRY_STATUSES = new Set([502, 503, 504]);
// Mid-stream failures worth a fresh request. The client-facing message says
// "terminated" so DSH and Pi classify them as transport errors;
// ZCode reads providerCode and recovers "network_error_retryable" streams.
const TRANSIENT_STREAM_CODES = new Set(["upstream_stream_incomplete", "missing_finish_reason", "upstream_stream_error", "upstream_connection_error"]);

export function createProxy({ upstream = "https://api.mistral.ai", log = () => {}, idleMs = 180_000, retryDelaysMs = PRE_STREAM_RETRY_DELAYS_MS, captureDir = process.env.MISTRAL_BRIDGE_CAPTURE_DIR || undefined, keyResolver = resolveKey, requireEnvKey = false, role = "proxy", sourceSha256 = role === "zcode-daemon" ? credentialSourceId() : undefined } = {}) {
  let activeRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (!localRequest(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Only local host requests are allowed", code: "forbidden_origin" } }));
      return;
    }
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "mistral-bridge", role, version: VERSION, coreSha256: CORE_SHA256, sourceSha256, pid: process.pid, activeRequests, maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES }));
      return;
    }
    if (!/^\/v1\/(chat\/completions|models(?:\/[^/?]+)?)(?:\?.*)?$/.test(req.url || "")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported bridge endpoint" } }));
      return;
    }
    activeRequests++;
    const requestId = createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12);
    const abort = new AbortController();
    let timer, streamed = false, idle = false, requestBytes = 0;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { idle = true; abort.abort(); }, idleMs);
      timer.unref();
    };
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", cancel);
    req.on("aborted", cancel);
    touch();
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        touch(); size += chunk.length;
        requestBytes = size;
        if (size > 16 * 1024 * 1024) throw new Error("request_too_large");
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      const isChat = req.url.split("?")[0] === "/v1/chat/completions";
      if (isChat && body.length) {
        let obj;
        try { obj = JSON.parse(body.toString("utf8")); } catch { throw new Error("invalid_request_json"); }
        rewriteRequest(obj);
        const omitted = limitRequestImages(obj);
        if (omitted) log(`request=${requestId} images_omitted=${omitted}`);
        body = Buffer.from(JSON.stringify(obj));
      }
      requestBytes = body.length;
      if (isChat && requestBytes > MAX_REQUEST_BODY_BYTES) throw new Error("request_too_large");
      const headers = headersWithoutHopByHop(req.headers);
      headers["accept-encoding"] = "identity";
      // Resolve legacy references; native Models credentials pass through.
      const authorization = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
      const placeholder = /^Bearer\s+env:([A-Za-z0-9._-]+)$/i.exec(authorization);
      if (placeholder || requireEnvKey) {
        const key = placeholder ? await keyResolver(`env:${placeholder[1]}`) : null;
        if (!key) {
          log(`request=${requestId} error=missing_env_key`);
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({
            error: {
              message: placeholder ? `mistral-bridge: no key named "${placeholder[1]}" in .env` : "mistral-bridge: an env:<name> credential reference is required",
              type: "bridge_error",
              code: "missing_env_key",
            },
          }));
          return;
        }
        headers.authorization = `Bearer ${key}`;
      }
      let up;
      for (let attempt = 0; ; attempt++) {
        let reason;
        try {
          up = await fetch(`${upstream}${req.url}`, {
            method: req.method, headers, redirect: "error", signal: abort.signal,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
          });
          if (!RETRY_STATUSES.has(up.status) || attempt >= retryDelaysMs.length) break;
          reason = `status_${up.status}`;
          await up.body?.cancel().catch(() => {});
        } catch (error) {
          if (abort.signal.aborted || attempt >= retryDelaysMs.length) throw error;
          reason = "connection_error";
        }
        log(`request=${requestId} retry=${attempt + 1} reason=${reason}`);
        await sleep(retryDelaysMs[attempt], undefined, { signal: abort.signal });
        touch();
      }
      touch();
      const responseHeaders = headersWithoutHopByHop(up.headers);
      const contentType = up.headers.get("content-type") || "";
      const upstreamId = up.headers.get("x-request-id") || "-";
      log(`request=${requestId} status=${up.status} request_bytes=${requestBytes} upstream_id=${upstreamId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)}`);
      if (!up.ok && isChat && captureDir) {
        // Opt-in diagnostics: keep the rewritten body (it holds conversation
        // content but never the key) so failing requests can be replayed.
        try {
          mkdirSync(captureDir, { recursive: true, mode: 0o700 });
          writeFileSync(path.join(captureDir, `${requestId}-${up.status}.json`), body, { mode: 0o600 });
          log(`request=${requestId} captured=${requestId}-${up.status}.json`);
        } catch {}
      }
      // Error bodies retain their original HTTP status and JSON; never parse as SSE.
      if (up.ok && isChat && contentType.includes("text/event-stream") && up.body) {
        res.writeHead(up.status, { ...responseHeaders, "cache-control": "no-cache", "x-accel-buffering": "no" });
        res.flushHeaders(); streamed = true;
        for await (const frame of transformSse(up.body, touch)) {
          if (res.destroyed) throw new Error("client_disconnected");
          if (!res.write(frame)) await once(res, "drain", { signal: abort.signal });
        }
        res.end();
        log(`request=${requestId} complete=sse`);
      } else {
        const chunks = [];
        if (up.body) for await (const chunk of up.body) { touch(); chunks.push(Buffer.from(chunk)); }
        let raw = Buffer.concat(chunks);
        if (up.ok && isChat && contentType.includes("application/json") && raw.length) {
          raw = Buffer.from(JSON.stringify(rewriteResponse(JSON.parse(raw.toString("utf8")))));
        }
        res.writeHead(up.status, responseHeaders);
        res.end(raw);
        log(`request=${requestId} complete=${up.ok ? "json" : "http_error"}`);
      }
    } catch (error) {
      const known = /^(unsupported_\w+|missing_finish_reason|invalid_sse_json|upstream_stream_\w+|sse_event_too_large|invalid_request_json|request_too_large|client_disconnected)$/;
      const code = idle ? "upstream_idle_timeout" : known.test(error.message) ? error.message : "upstream_connection_error";
      log(`request=${requestId} error=${code} request_bytes=${requestBytes}`);
      if (!res.destroyed) {
        if (streamed) {
          // Signal failure, then break the transport: normal EOF would flush a
          // partial tool call in ZCode's SDK. The bridge never retries after
          // streamed output; the host may re-run the whole step.
          const error = TRANSIENT_STREAM_CODES.has(code)
            ? { message: `mistral-bridge: upstream connection terminated mid-stream (${code}, request ${requestId})`, type: "bridge_error", code, providerCode: "network_error_retryable" }
            : { message: `mistral-bridge: ${code} (request ${requestId})`, type: "bridge_error", code };
          // Destroying immediately would discard the queued frame.
          res.write(`data: ${JSON.stringify({ error })}\n\n`, () => res.destroy());
          setTimeout(() => res.destroy(), 1000).unref();
        } else {
          res.writeHead(code === "request_too_large" ? 413 : code === "invalid_request_json" ? 400 : 502, { "content-type": "application/json" });
          const message = code === "request_too_large"
            ? `mistral-bridge: request body too large (${requestBytes} bytes; limit ${MAX_REQUEST_BODY_BYTES} bytes). Compact the conversation or start a new session with fewer images or smaller tool results. Retrying the unchanged request will not help. (request ${requestId})`
            : `mistral-bridge: ${code} (request ${requestId})`;
          res.end(JSON.stringify({ error: { message, type: "bridge_error", code } }));
        }
      }
    } finally {
      clearTimeout(timer); abort.abort();
      res.off("close", cancel); req.off("aborted", cancel);
      activeRequests--;
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 60_000;
  return server;
}

export async function startProxy({ port = PROXY_PORT, log = () => {}, keyResolver } = {}) {
  const server = createProxy({ log, keyResolver, role: "zcode-daemon" });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    log(`mistral-bridge ${VERSION} listening port=${port} core=${CORE_SHA256}`);
    return server;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    let health;
    try { health = await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).json(); } catch {}
    if (health?.service !== "mistral-bridge" || health.role !== "zcode-daemon" || health.coreSha256 !== CORE_SHA256 || health.sourceSha256 !== credentialSourceId()) {
      throw new Error(`Port ${port} is owned by an unknown or outdated proxy; restart the standalone Mistral bridge`);
    }
    log(`using shared proxy version=${health.version} core=${health.coreSha256}`);
    return null;
  }
}
