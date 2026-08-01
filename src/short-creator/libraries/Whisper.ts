import { spawn } from "child_process";
import path from "path";
import fs from "fs-extra";

import { Config } from "../../config";
import type { Caption } from "../../types/shorts";
import { logger } from "../../logger";

export const ErrorWhisper = new Error("There was an error with WhisperCpp");

// whisper.cpp JSON output shape (with -oj -ml 1)
interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  t_dtw?: number;
}
interface WhisperSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens: WhisperToken[];
}
interface WhisperJson {
  transcription: WhisperSegment[];
}

export class Whisper {
  private binaryPath: string;
  private modelPath: string;

  constructor(config: Config) {
    // In Docker the binary is at /app/bin/whisper and model at /app/data/libs/whisper/models/
    this.binaryPath =
      process.env.WHISPER_BINARY ??
      path.join(config.whisperInstallPath, "main");
    this.modelPath =
      process.env.WHISPER_MODEL_PATH ??
      path.join(config.whisperInstallPath, "models", `ggml-${config.whisperModel}.bin`);
  }

  // Drop-in replacement — no download needed (binary is pre-installed in Docker)
  static async init(config: Config): Promise<Whisper> {
    const w = new Whisper(config);
    if (!fs.existsSync(w.binaryPath)) {
      logger.warn(
        { binaryPath: w.binaryPath },
        "whisper binary not found — transcription will fail at runtime",
      );
    } else {
      logger.info({ binaryPath: w.binaryPath, model: w.modelPath }, "Whisper ready");
    }
    return w;
  }

  async CreateCaption(audioPath: string): Promise<Caption[]> {
    logger.debug({ audioPath }, "Starting to transcribe audio");

    const outputBase = audioPath.replace(/\.\w+$/, "_whisper");
    const jsonPath = `${outputBase}.json`;

    // Clean up stale output
    if (fs.existsSync(jsonPath)) fs.removeSync(jsonPath);

    const args = [
      "-m", this.modelPath,
      "-f", audioPath,
      "-oj",           // JSON output
      "-ml", "1",      // max-length 1 word per segment → word-level timestamps
      "-of", outputBase,
      "-l", "en",
      "--no-prints",
    ];

    // Verify audio file is not empty before running whisper
    const audioStat = fs.statSync(audioPath);
    if (audioStat.size < 1000) {
      throw new Error(`Audio file too small for transcription: ${audioStat.size} bytes at ${audioPath}`);
    }

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, { stdio: "pipe" });
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code: number | null, signal: string | null) => {
        if (code === 0) resolve();
        else reject(new Error(`whisper exited ${code} signal=${signal}: ${stderr.slice(-800)}`));
      });
      proc.on("error", reject);
    });

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`whisper did not produce ${jsonPath}`);
    }

    const raw: WhisperJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    fs.removeSync(jsonPath);

    logger.debug({ audioPath }, "Transcription finished, creating captions");

    const captions: Caption[] = [];

    for (const segment of raw.transcription ?? []) {
      if (!segment.text?.trim()) continue;

      for (const token of segment.tokens ?? []) {
        const text = token.text;
        if (!text || text.startsWith("[_TT")) continue;

        // Merge tokens that don't start with a space into the previous caption
        if (
          captions.length > 0 &&
          !text.startsWith(" ") &&
          !captions[captions.length - 1].text.endsWith(" ")
        ) {
          captions[captions.length - 1].text += text;
          captions[captions.length - 1].endMs = token.offsets.to;
          continue;
        }

        captions.push({
          text,
          startMs: token.offsets.from,
          endMs: token.offsets.to,
        });
      }
    }

    logger.debug({ audioPath, captionCount: captions.length }, "Captions created");
    return captions;
  }
}
