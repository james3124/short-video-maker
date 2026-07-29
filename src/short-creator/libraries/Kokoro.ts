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

    const response = await axios.post(
      `${KOKORO_API_URL}/tts`,
      {
        text,
        voice,
        speed: Number(process.env.KOKORO_SPEED ?? 1),
        lang_code: process.env.KOKORO_LANG_CODE ?? "a",
        split_pattern: "\\n+",
      },
      {
        responseType: "arraybuffer",
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      },
    );

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
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", (code) => {
      const dur = parseFloat(out.trim());
      if (code === 0 && !isNaN(dur)) resolve(dur);
      else reject(new Error(`ffprobe failed (code ${code}) on ${filePath}`));
    });
    proc.on("error", reject);
  });
}
