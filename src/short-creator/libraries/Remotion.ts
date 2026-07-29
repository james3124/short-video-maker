/**
 * Remotion.ts — replaced with pure FFmpeg compositing.
 * Same public interface as before so ShortCreator needs no changes.
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs-extra";
import z from "zod";

import { Config } from "../../config";
import { shortVideoSchema } from "../../components/utils";
import { logger } from "../../logger";
import { OrientationEnum } from "../../types/shorts";
import type { Caption } from "../../types/shorts";

const MUSIC_VOLUME: Record<string, number> = {
  muted: 0,
  low: 0.08,
  medium: 0.15,
  high: 0.25,
};

// Alignment: 2=bottom-center, 5=middle-center, 8=top-center (ASS spec)
const CAPTION_ALIGNMENT: Record<string, number> = {
  top: 8,
  center: 5,
  bottom: 2,
};

export class Remotion {
  constructor(private config: Config) {}

  // No browser download needed — init is now instant
  static async init(config: Config): Promise<Remotion> {
    logger.info("FFmpeg renderer ready (no Chromium needed)");
    return new Remotion(config);
  }

  async render(
    data: z.infer<typeof shortVideoSchema>,
    id: string,
    orientation: OrientationEnum,
  ): Promise<void> {
    const { scenes, music, config: renderConfig } = data;
    const { w, h } = orientation === OrientationEnum.portrait
      ? { w: 1080, h: 1920 }
      : { w: 1920, h: 1080 };

    const tempDir = this.config.tempDirPath;
    const outputPath = path.join(this.config.videosDirPath, `${id}.mp4`);

    logger.debug({ id, sceneCount: scenes.length, orientation }, "FFmpeg render start");

    // ── Render each scene to a clip ──────────────────────────────────────────
    const clipPaths: string[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const clipPath = path.join(tempDir, `${id}_clip_${i}.mp4`);

      // Extract file paths from localhost URLs
      const videoPath = urlToPath(scene.video, tempDir);
      const audioPath = wavPathFromMp3Url(scene.audio.url, tempDir);
      const duration = scene.audio.duration;

      // Generate SRT from Caption[]
      const srtPath = path.join(tempDir, `${id}_scene_${i}.srt`);
      writeSRT(scene.captions, srtPath);

      const captionPos = renderConfig.captionPosition ?? "bottom";
      const alignment = CAPTION_ALIGNMENT[captionPos] ?? 2;
      const bgColor = cssColorToAss(renderConfig.captionBackgroundColor ?? "blue");
      const fontSize = orientation === OrientationEnum.portrait ? 22 : 14;
      const marginV = orientation === OrientationEnum.portrait ? 80 : 40;

      const subtitleFilter =
        `subtitles=${escapePath(srtPath)}:force_style='` +
        `FontName=Liberation Sans,` +
        `FontSize=${fontSize},` +
        `PrimaryColour=&H00FFFFFF,` +
        `OutlineColour=&H00000000,` +
        `BackColour=${bgColor},` +
        `Outline=2,Shadow=1,` +
        `MarginV=${marginV},` +
        `Alignment=${alignment}'`;

      await runFFmpeg([
        "-stream_loop", "-1", "-i", videoPath,
        "-i", audioPath,
        "-filter_complex",
          `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
          `crop=${w}:${h},setsar=1,${subtitleFilter}[v]`,
        "-map", "[v]",
        "-map", "1:a",
        "-t", String(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        clipPath,
      ]);

      clipPaths.push(clipPath);
      fs.removeSync(srtPath);
      logger.debug({ i, clipPath }, "Scene clip done");
    }

    // ── Concat all clips ──────────────────────────────────────────────────────
    const concatList = path.join(tempDir, `${id}_concat.txt`);
    fs.writeFileSync(
      concatList,
      clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    );

    const musicVol = MUSIC_VOLUME[renderConfig.musicVolume ?? "high"] ?? 0.25;
    const musicFilePath = music?.file ? path.join(this.config.musicDirPath, music.file) : null;
    const hasMusicFile = musicFilePath && fs.existsSync(musicFilePath);

    if (!hasMusicFile || musicVol === 0) {
      // No music — just concat
      await runFFmpeg([
        "-f", "concat", "-safe", "0", "-i", concatList,
        "-c", "copy",
        outputPath,
      ]);
    } else {
      // Concat to intermediate then mix music
      const concatPath = path.join(tempDir, `${id}_concat.mp4`);
      await runFFmpeg([
        "-f", "concat", "-safe", "0", "-i", concatList,
        "-c", "copy",
        concatPath,
      ]);

      await runFFmpeg([
        "-i", concatPath,
        "-stream_loop", "-1", "-i", musicFilePath!,
        "-filter_complex",
          `[1:a]volume=${musicVol}[music];` +
          `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        "-map", "0:v",
        "-map", "[a]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath,
      ]);

      fs.removeSync(concatPath);
    }

    // Cleanup
    fs.removeSync(concatList);
    for (const clip of clipPaths) fs.removeSync(clip);

    logger.debug({ id, outputPath }, "FFmpeg render complete");
  }

  // testRender no longer needs Chromium — just verifies ffmpeg is available
  async testRender(outputPath: string): Promise<void> {
    await runFFmpeg([
      "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=1",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac",
      "-t", "1",
      "-shortest",
      outputPath,
    ]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function urlToPath(url: string, dir: string): string {
  const filename = url.split("/").pop()!;
  return path.join(dir, filename);
}

function wavPathFromMp3Url(mp3Url: string, dir: string): string {
  const mp3File = mp3Url.split("/").pop()!;
  const wavFile = mp3File.replace(/\.mp3$/, ".wav");
  const wavPath = path.join(dir, wavFile);
  // Prefer WAV (already normalized), fall back to MP3
  return fs.existsSync(wavPath) ? wavPath : path.join(dir, mp3File);
}

function escapePath(p: string): string {
  // Escape colons and backslashes for FFmpeg filter_complex
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function writeSRT(captions: Caption[], srtPath: string): void {
  let out = "";
  captions.forEach((c, i) => {
    out += `${i + 1}\n`;
    out += `${msToSRTTime(c.startMs)} --> ${msToSRTTime(c.endMs)}\n`;
    out += `${c.text.trim()}\n\n`;
  });
  fs.writeFileSync(srtPath, out, "utf-8");
}

function msToSRTTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const ms2 = ms % 1_000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms2)}`;
}

function pad2(n: number) { return String(n).padStart(2, "0"); }
function pad3(n: number) { return String(n).padStart(3, "0"); }

function cssColorToAss(color: string): string {
  const MAP: Record<string, string> = {
    blue:    "&H00FF0000",
    red:     "&H000000FF",
    green:   "&H0000FF00",
    yellow:  "&H0000FFFF",
    white:   "&H00FFFFFF",
    black:   "&H00000000",
    purple:  "&H00800080",
    orange:  "&H000080FF",
  };
  if (MAP[color.toLowerCase()]) return MAP[color.toLowerCase()];
  const hex = color.replace("#", "");
  if (hex.length === 6) {
    return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
  }
  return "&H00FF0000";
}

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        logger.error({ stderr: stderr.slice(-3000) }, "ffmpeg failed");
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
