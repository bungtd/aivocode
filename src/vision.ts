import { existsSync, readFileSync, statSync } from "node:fs";
import type { AivoWire } from "./config.js";
import type { AivoModelInfo } from "./aivokey-client.js";

export type SupportedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageMagicInfo {
  mimeType: SupportedImageMime;
  width: number;
  height: number;
}

export interface ImageAttachment {
  filePath: string;
  mimeType: SupportedImageMime;
  width: number;
  height: number;
  byteSize: number;
  base64: string;
  dataUrl: string;
}

const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // 5 MiB base64

/**
 * Detects PNG, JPEG, GIF, and WebP from raw file bytes (magic header inspection)
 * and extracts pixel dimensions (`width` × `height`).
 */
export function detectImageMagic(buf: Buffer): ImageMagicInfo | null {
  if (buf.length < 16) return null;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR at offset 16..24
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf.length >= 24
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { mimeType: "image/png", width, height };
  }

  // 2. GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { mimeType: "image/gif", width, height };
  }

  // 3. WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50 &&
    buf.length >= 30
  ) {
    let width = 0;
    let height = 0;
    const chunkHeader = buf.toString("ascii", 12, 16);
    if (chunkHeader === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkHeader === "VP8L" && buf.length >= 25) {
      const b0 = buf[21]!;
      const b1 = buf[22]!;
      const b2 = buf[23]!;
      const b3 = buf[24]!;
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    }
    return { mimeType: "image/webp", width, height };
  }

  // 4. JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    let width = 0;
    let height = 0;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3
      ) {
        height = buf.readUInt16BE(offset + 5);
        width = buf.readUInt16BE(offset + 7);
        break;
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { mimeType: "image/jpeg", width, height };
  }

  return null;
}

export function isImageFilePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(filePath.trim());
}

export function loadImageAttachment(absPath: string): ImageAttachment {
  if (!existsSync(absPath)) {
    throw new Error(`Image file not found: ${absPath}`);
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new Error(`Path is not a file: ${absPath}`);
  }
  if (st.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(
      `Image file exceeds 20 MiB limit (${(st.size / (1024 * 1024)).toFixed(1)} MiB): ${absPath}`,
    );
  }
  const buf = readFileSync(absPath);
  const magic = detectImageMagic(buf);
  if (!magic) {
    throw new Error(
      `Unsupported or corrupted image format (must be PNG, JPEG, GIF, or WebP): ${absPath}`,
    );
  }
  const base64 = buf.toString("base64");
  if (base64.length > MAX_IMAGE_BASE64_BYTES) {
    throw new Error(
      `Encoded base64 image exceeds 5 MiB limit (${(base64.length / (1024 * 1024)).toFixed(1)} MiB). Resize or compress the image first: ${absPath}`,
    );
  }

  return {
    filePath: absPath,
    mimeType: magic.mimeType,
    width: magic.width,
    height: magic.height,
    byteSize: buf.length,
    base64,
    dataUrl: `data:${magic.mimeType};base64,${base64}`,
  };
}

/**
 * Formats multimodal text + image content blocks for any of AivoKey's 3 wires
 * (`chat` -> `/v1/chat/completions`, `messages` -> `/v1/messages`, `responses` -> `/v1/responses`).
 */
export function buildMultimodalContentForWire(
  text: string,
  images: ImageAttachment[],
  wire: AivoWire,
): Array<Record<string, unknown>> {
  if (wire === "messages") {
    return [
      { type: "text", text },
      ...images.map((img) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType,
          data: img.base64,
        },
      })),
    ];
  }

  if (wire === "responses") {
    return [
      { type: "input_text", text },
      ...images.map((img) => ({
        type: "input_image",
        image_url: img.dataUrl,
      })),
    ];
  }

  // wire === "chat"
  return [
    { type: "text", text },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: img.dataUrl },
    })),
  ];
}

/**
 * Ensures the model used for a turn with image attachments supports vision.
 * If the current model is text-only, picks the best vision-capable model from the catalog.
 */
export function pickVisionCapableModel(
  currentModel: string,
  catalog: AivoModelInfo[],
): string {
  const current = catalog.find((m) => m.id === currentModel);
  if (!current || current.supportsVision) {
    return currentModel;
  }
  const visionModels = catalog.filter((m) => m.supportsVision && m.supportsTools);
  if (visionModels.length === 0) {
    const anyVision = catalog.find((m) => m.supportsVision);
    return anyVision ? anyVision.id : currentModel;
  }
  const preferredOrder = [
    "deepseek-v4-flash",
    "gemini-3.8-flash",
    "claude-sonnet-5-5",
    "gpt-5.6-luna",
    "glm-5.3-flash",
  ];
  for (const pref of preferredOrder) {
    if (visionModels.some((m) => m.id === pref)) return pref;
  }
  return visionModels[0]!.id;
}
