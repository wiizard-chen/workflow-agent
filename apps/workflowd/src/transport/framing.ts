import { canonicalizeJson, type JsonValue } from "@pi-workflow/v2-domain";

import {
  MAX_TRANSPORT_FRAME_BYTES,
  type TransportRejection,
  type WorkflowResult,
} from "./types.js";

function rejection(code: TransportRejection["code"], diagnostic: string): WorkflowResult<never> {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, diagnostic }) });
}
function success<T>(value: T): WorkflowResult<T> {
  return Object.freeze({ ok: true as const, value });
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(value: unknown): WorkflowResult<Buffer> {
  try {
    const canonical = canonicalizeJson(value as JsonValue);
    if (!canonical.ok) return rejection("frame_invalid", "json_not_canonical");
    const payload = Buffer.from(canonical.text, "utf8");
    if (payload.length === 0 || payload.length > MAX_TRANSPORT_FRAME_BYTES) return rejection("frame_too_large", "frame_length_exceeded");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return success(frame);
  } catch {
    return rejection("frame_invalid", "frame_encode_failed");
  }
}

function decodePayload(payload: Buffer): WorkflowResult<unknown> {
  try {
    const text = decoder.decode(payload);
    const parsed = JSON.parse(text) as JsonValue;
    const canonical = canonicalizeJson(parsed);
    if (!canonical.ok || canonical.text !== text) return rejection("frame_invalid", "json_not_canonical");
    return success(canonical.value);
  } catch {
    return rejection("frame_invalid", "json_decode_failed");
  }
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): WorkflowResult<readonly unknown[]> {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_TRANSPORT_FRAME_BYTES * 8) return rejection("frame_too_large", "incoming_chunk_too_large");
    try {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      const messages: unknown[] = [];
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length === 0) return rejection("frame_invalid", "empty_frame");
        if (length > MAX_TRANSPORT_FRAME_BYTES) return rejection("frame_too_large", "frame_length_exceeded");
        if (this.buffer.length < length + 4) break;
        const payload = this.buffer.subarray(4, length + 4);
        const decoded = decodePayload(payload);
        if (!decoded.ok) return decoded;
        messages.push(decoded.value);
        this.buffer = this.buffer.subarray(length + 4);
      }
      if (this.buffer.length > MAX_TRANSPORT_FRAME_BYTES + 4) return rejection("frame_too_large", "partial_frame_exceeded");
      return success(Object.freeze(messages));
    } catch {
      return rejection("frame_invalid", "frame_buffer_failed");
    }
  }

  end(): WorkflowResult<true> {
    return this.buffer.length === 0 ? success(true as const) : rejection("frame_invalid", "truncated_frame");
  }
}
