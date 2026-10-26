import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectImageMagic,
  loadImageAttachment,
  buildMultimodalContentForWire,
  pickVisionCapableModel,
} from "../src/vision.js";
import { executeComputerUse } from "../src/computer-use.js";

// Valid 1x1 transparent PNG bytes
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("Multimodal Vision & Computer Use", () => {
  it("detects PNG magic bytes, extracts width × height, and builds multimodal wire blocks for chat, messages, and responses", () => {
    const dir = mkdtempSync(join(tmpdir(), "aivo-vision-"));
    try {
      const imgPath = join(dir, "ui-mockup.png");
      writeFileSync(imgPath, ONE_BY_ONE_PNG);

      const magic = detectImageMagic(ONE_BY_ONE_PNG);
      expect(magic).not.toBeNull();
      expect(magic?.mimeType).toBe("image/png");
      expect(magic?.width).toBe(1);
      expect(magic?.height).toBe(1);

      const att = loadImageAttachment(imgPath);
      expect(att.mimeType).toBe("image/png");
      expect(att.width).toBe(1);
      expect(att.height).toBe(1);
      expect(att.dataUrl).toMatch(/^data:image\/png;base64,/);

      const chatBlocks = buildMultimodalContentForWire("Analyze this UI", [att], "chat");
      expect(chatBlocks).toHaveLength(2);
      expect(chatBlocks[1]?.type).toBe("image_url");

      const msgBlocks = buildMultimodalContentForWire("Analyze this UI", [att], "messages");
      expect(msgBlocks).toHaveLength(2);
      expect(msgBlocks[1]?.type).toBe("image");

      const respBlocks = buildMultimodalContentForWire("Analyze this UI", [att], "responses");
      expect(respBlocks).toHaveLength(2);
      expect(respBlocks[1]?.type).toBe("input_image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("automatically selects a vision-capable model when the active model is text-only", () => {
    const catalog = [
      {
        id: "text-only-coder",
        name: "Text Coder",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        supportsPromptCache: true,
        supportsJsonMode: true,
        supportedEfforts: [],
        inputMicroPer1M: 300_000n,
        outputMicroPer1M: 1_200_000n,
        cacheReadMicroPer1M: 50_000n,
        cacheWriteMicroPer1M: null,
        category: "coding",
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: true,
        supportsPromptCache: true,
        supportsJsonMode: true,
        supportedEfforts: [],
        inputMicroPer1M: 300_000n,
        outputMicroPer1M: 1_200_000n,
        cacheReadMicroPer1M: 50_000n,
        cacheWriteMicroPer1M: null,
        category: "flagship",
      },
    ];

    expect(pickVisionCapableModel("text-only-coder", catalog)).toBe("deepseek-v4-flash");
    expect(pickVisionCapableModel("deepseek-v4-flash", catalog)).toBe("deepseek-v4-flash");
  });

  it("executes computer_use actions via injected runner and returns structured output", async () => {
    const res = await executeComputerUse(
      { action: "window_list" },
      {
        runCommand: async () => "chrome | Google Chrome\ncode | Visual Studio Code",
      },
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("Google Chrome");
    expect(res.output).toContain("Visual Studio Code");
  });
});
