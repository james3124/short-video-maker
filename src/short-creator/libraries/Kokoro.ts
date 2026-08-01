import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { VoiceEnum, type Voices } from "../../types/shorts";
import { logger } from "../../logger";

const KOKORO_API_URL = (
  process.env.KOKORO_API_URL ?? "https://kokoro-tts-tfeq.onrender.com"
).replace(/\/$/, "");

export class Kokoro {
  // Static init kept for drop-in compatibility with index.ts
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

    // Wake up Kokoro first (free tier cold start can take 50+ seconds)
    // Send a cheap GET request to trigger the spin-up before the heavy TTS call
    logger.debug("Pinging Kokoro to wake it up...");
    await axios.get(`${KOKORO_API_URL}/health`, { timeout: 90_000 }).catch(() => {});
    logger.debug("Kokoro ping done, sending TTS request");

    // Retry up to 6 times with increasing waits (total ~2.5 min budget)
    let response: any = null;
    const maxRetries = 6;
    const retryWaits = [5_000, 10_000, 15_000, 20_000, 25_000, 30_000];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await axios.post(`${KOKORO_API_URL}/tts`, payload, {
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
          logger.warn({ attempt, status, wait }, "Kokoro cold start, retrying...");
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }

    if (!response) throw new Error("Kokoro TTS failed after all retries");
    const audioBuffer: ArrayBuffer = response.data;

    // Write to temp file to probe duration
    const tmpPath = path.join(
      process.env.DATA_DIR_PATH ?? "/tmp",
      `kokoro_tmp_${Date.now()}.wav`,
    );
    await fs.outputFile(tmpPath, Buffer.from(audioBuffer));

    const audioLength = await probeDuration(tmpPath);
    await fs.remove(tmpPath);

    logger.debug({ voice, audioLength }, "Kokoro TTS complete");
    return { audio: audioBuffer, audioLength };
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
