// Optional Pi extension for the native Mistral provider; no proxy or key changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MAX_REQUEST_BODY_BYTES, MAX_REQUEST_IMAGE_BYTES, MAX_REQUEST_IMAGES } from "./request-budget.mjs";

// Pi 1.4's native provider renames camelCase keys after onPayload. Reserve
// additional room for that serialization rather than treating tokens as bytes.
const SERIALIZATION_RESERVE = 64 * 1024;
const bytes = payload => Buffer.byteLength(JSON.stringify(payload), "utf8");

export function prepareMistralRequest(payload, { archiveDir = path.join(os.homedir(), ".pi", "agent", "mistral-image-archive") } = {}) {
  if (!payload || !Array.isArray(payload.messages)) throw new Error("Unsupported native Mistral payload; request cancelled.");
  const next = structuredClone(payload);
  const images = [];
  for (const message of next.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const [index, block] of message.content.entries()) {
      if (block?.type !== "image_url") continue;
      const url = block.imageUrl ?? (typeof block.image_url === "string" ? block.image_url : block.image_url?.url);
      const match = typeof url === "string" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
      if (match) images.push({ message, index, mediaType: match[1], data: match[2], bytes: Buffer.byteLength(match[2]) });
    }
  }
  const beforeBytes = bytes(next);
  let bodyBytes = beforeBytes, imageBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  const archived = [];
  // Keep the newest screenshot. A single image may exceed the soft 4 MiB
  // image target provided the complete request still fits the hard body cap.
  // Mistral also rejects a 21st image with a misleading 503.
  for (const image of images.slice(0, -1)) {
    if (imageBytes <= MAX_REQUEST_IMAGE_BYTES && bodyBytes <= MAX_REQUEST_BODY_BYTES - SERIALIZATION_RESERVE
      && images.length - archived.length <= MAX_REQUEST_IMAGES) break;
    const data = Buffer.from(image.data, "base64");
    const digest = createHash("sha256").update(data).digest("hex");
    const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.slice(6);
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const file = path.join(archiveDir, `${digest}.${extension}`);
    try { fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    image.message.content[image.index] = { type: "text", text: `[Older screenshot omitted from this request to fit Mistral request limits. Saved image: ${JSON.stringify(file)}. Use an image-reading tool if needed. The original remains in session history.]` };
    archived.push(file);
    imageBytes -= image.bytes;
    bodyBytes = bytes(next);
  }
  if (bodyBytes > MAX_REQUEST_BODY_BYTES - SERIALIZATION_RESERVE) {
    throw new Error(`Mistral request body too large: ${bodyBytes} bytes plus serialization reserve; limit ${MAX_REQUEST_BODY_BYTES}. Request cancelled before sending. Use /compact or start a new session with smaller tool output or a smaller latest screenshot. Unchanged retries will not help.`);
  }
  return { payload: next, beforeBytes, bodyBytes, imageBytes, archived };
}

export default function mistralRequestBudget(pi, options) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "mistral" || ctx.model?.api !== "mistral-conversations") return;
    try {
      const result = prepareMistralRequest(event.payload, options);
      if (result.archived.length) ctx.ui.notify(`Mistral: omitted ${result.archived.length} older screenshot(s) from this request; saved originals locally. Payload ${(result.bodyBytes / 1048576).toFixed(2)} MiB.`, "warning");
      return result.payload;
    } catch (error) {
      // Pi catches extension exceptions and otherwise continues with the original
      // payload. Abort explicitly so a failed guard cannot send it upstream.
      ctx.abort();
      ctx.ui.notify(error.message, "error");
      throw error;
    }
  });
}
