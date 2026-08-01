import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { VoiceEnum, type Voices } from "../../types/shorts";
import { logger } from "../../logger";

const KOKORO_API_URL = (
  process.env.KOKORO_API_URL ?? "https://kokoro-tts-onnx.vercel.app"
).replace(/\/$/, "");

export class Kokoro {
  static async init(_precision?: string): Promise<Kokoro> {
    logger.info({ url: KOKORO_API_URL }, "Kokoro: using external TTS API");
    return new Kokoro();
  }

  async generate(
    text: string,
    voice: Voices,
  ): Promise<{ audio: ArrayBuffer; audioLength: number }> {
    logger.debug({ voice, textLength: text.length }, "Calling external Kokoro TTS");

    const payload = {
      text,
      voice,
      speed: Number(process.env.KOKORO_SPEED ?? 1),
      lang_code: process.env.KOKORO_LANG_CODE ?? "a",
      split_pattern: "\\n+",
    };

    // Quick health check — confirm server is up
    try {
      const healthRes = await axios.get(`${KOKORO_API_URL}/health`, { timeout: 15_000 });
      logger.info({ health: healthRes.data }, "Kokoro server is up");
    } catch {
      logger.warn("Kokoro health check failed — attempting TTS anyway");
    }

    // Send TTS with retries (model loads lazily on first request)
    let ttsResponse: any = null;
    const maxRetries = 5;
    const retryWaits = [5_000, 10_000, 15_000, 20_000, 30_000];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        ttsResponse = await axios.post(`${KOKORO_API_URL}/tts`, payload, {
          responseType: "arraybuffer",
          timeout: 120_000,
          headers: { "Content-Type": "application/json" },
        });
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        const isRetryable = !status || status === 502 || status === 503 || status === 504;
        if (isRetryable && attempt < maxRetries) {
          const wait = retryWaits[attempt - 1];
          logger.warn({ attempt, status, wait }, "Kokoro TTS failed, retrying...");
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }

    if (!ttsResponse) throw new Error("Kokoro TTS failed after all retries");

    // Vercel Kokoro may return a URL (JSON/text) instead of raw audio bytes
    const contentType: string = ttsResponse.headers?.["content-type"] ?? "";
    let audioBytes: Buffer;

    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      const text2 = Buffer.from(ttsResponse.data as ArrayBuffer).toString("utf-8").trim();
      let audioUrl: string;
      try {
        const parsed = JSON.parse(text2);
        audioUrl = parsed.audio_url ?? parsed.url ?? parsed.file_url ?? text2;
      } catch {
        audioUrl = text2;
      }
      logger.debug({ audioUrl }, "Kokoro returned URL, downloading audio");
      const dlRes = await axios.get(audioUrl, {
        responseType: "arraybuffer",
        timeout: 60_000,
      });
      audioBytes = Buffer.from(dlRes.data as ArrayBuffer);
    } else {
      audioBytes = Buffer.from(ttsResponse.data as ArrayBuffer);
    }

    // Write to temp file to probe duration via ffprobe
    const tmpPath = path.join(
      process.env.DATA_DIR_PATH ?? "/tmp",
      `kokoro_tmp_${Date.now()}.wav`,
    );
    await fs.outputFile(tmpPath, audioBytes);
    const audioLength = await probeDuration(tmpPath);
    await fs.remove(tmpPath);

    logger.debug({ voice, audioLength }, "Kokoro TTS complete");
    // Return as ArrayBuffer for compatibility with existing FFmpeg pipeline
    return { audio: audioBytes.buffer as ArrayBuffer, audioLength };
  }

  listAvailableVoices(): Voices[] {
    return Object.values(VoiceEnum) as Voices[];
  }
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number | null) => {
      const dur = parseFloat(out.trim());
      if (code === 0 && !isNaN(dur)) resolve(dur);
      else reject(new Error(`ffprobe failed (code ${code}) on ${filePath}`));
    });
    proc.on("error", reject);
  });
}
