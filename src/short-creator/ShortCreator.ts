import { OrientationEnum } from "./../types/shorts";
/* eslint-disable @remotion/deterministic-randomness */
import fs from "fs-extra";
import cuid from "cuid";
import path from "path";
import https from "https";
import http from "http";

import { Kokoro } from "./libraries/Kokoro";
import { Remotion } from "./libraries/Remotion";
import { Whisper } from "./libraries/Whisper";
import { FFMpeg } from "./libraries/FFmpeg";
import { PexelsAPI } from "./libraries/Pexels";
import { Config } from "../config";
import { logger } from "../logger";
import { MusicManager } from "./music";
import { uploadVideo, deleteVideoFromStorage } from "../services/storage";
import {
  createJob,
  markJobReady,
  markJobError,
  deleteJob,
  getJob,
  listJobs,
} from "../db/supabase";
import type {
  SceneInput,
  RenderConfig,
  Scene,
  VideoStatus,
  MusicMoodEnum,
  MusicTag,
  MusicForVideo,
} from "../types/shorts";

export class ShortCreator {
  private queue: {
    sceneInput: SceneInput[];
    config: RenderConfig;
    id: string;
  }[] = [];

  constructor(
    private config: Config,
    private remotion: Remotion,
    private kokoro: Kokoro,
    private whisper: Whisper,
    private ffmpeg: FFMpeg,
    private pexelsApi: PexelsAPI,
    private musicManager: MusicManager,
  ) {}

  public async status(id: string): Promise<VideoStatus> {
    if (this.queue.find((item) => item.id === id)) {
      return "processing";
    }
    try {
      const job = await getJob(id);
      if (!job) return "failed";
      if (job.status === "ready") return "ready";
      if (job.status === "error") return "failed";
      return "processing";
    } catch {
      return "failed";
    }
  }

  public addToQueue(sceneInput: SceneInput[], config: RenderConfig): string {
    const id = cuid();
    this.queue.push({ sceneInput, config, id });
    // Create the DB record right away so status polling works immediately
    createJob(id).catch((err) => logger.error(err, "Failed to create job record"));
    if (this.queue.length === 1) {
      this.processQueue();
    }
    return id;
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    const { sceneInput, config, id } = this.queue[0];
    logger.debug({ sceneInput, config, id }, "Processing video item in the queue");
    try {
      await this.createShort(id, sceneInput, config);
      logger.debug({ id }, "Video created successfully");
    } catch (error: unknown) {
      logger.error(error, "Error creating video");
      await markJobError(id, error instanceof Error ? error.message : "Unknown error").catch(() => {});
    } finally {
      this.queue.shift();
      this.processQueue();
    }
  }

  private async createShort(
    videoId: string,
    inputScenes: SceneInput[],
    config: RenderConfig,
  ): Promise<string> {
    logger.debug({ inputScenes, config }, "Creating short video");
    const scenes: Scene[] = [];
    let totalDuration = 0;
    const excludeVideoIds: string[] = [];
    const tempFiles: string[] = [];

    const orientation: OrientationEnum = config.orientation || OrientationEnum.portrait;

    let index = 0;
    for (const scene of inputScenes) {
      const audio = await this.kokoro.generate(scene.text, config.voice ?? "af_heart");
      let { audioLength } = audio;
      const { audio: audioStream } = audio;

      if (index + 1 === inputScenes.length && config.paddingBack) {
        audioLength += config.paddingBack / 1000;
      }

      const tempId = cuid();
      const tempWavFileName = `${tempId}.wav`;
      const tempMp3FileName = `${tempId}.mp3`;
      const tempVideoFileName = `${tempId}.mp4`;
      const tempWavPath = path.join(this.config.tempDirPath, tempWavFileName);
      const tempMp3Path = path.join(this.config.tempDirPath, tempMp3FileName);
      const tempVideoPath = path.join(this.config.tempDirPath, tempVideoFileName);
      tempFiles.push(tempVideoPath, tempWavPath, tempMp3Path);

      await this.ffmpeg.saveNormalizedAudio(audioStream, tempWavPath);
      const captions = await this.whisper.CreateCaption(tempWavPath);

      // Still save MP3 — FFmpeg renderer falls back to it if WAV isn't found
      await this.ffmpeg.saveToMp3(audioStream, tempMp3Path);

      const video = await this.pexelsApi.findVideo(
        scene.searchTerms,
        audioLength,
        excludeVideoIds,
        orientation,
      );

      logger.debug(`Downloading video from ${video.url} to ${tempVideoPath}`);

      await new Promise<void>((resolve, reject) => {
        const fileStream = fs.createWriteStream(tempVideoPath);
        https
          .get(video.url, (response: http.IncomingMessage) => {
            if (response.statusCode !== 200) {
              reject(new Error(`Failed to download video: ${response.statusCode}`));
              return;
            }
            response.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close();
              resolve();
            });
          })
          .on("error", (err: Error) => {
            fs.unlink(tempVideoPath, () => {});
            reject(err);
          });
      });

      excludeVideoIds.push(String(video.id));

      scenes.push({
        captions,
        video: `http://localhost:${this.config.port}/api/tmp/${tempVideoFileName}`,
        audio: {
          url: `http://localhost:${this.config.port}/api/tmp/${tempMp3FileName}`,
          duration: audioLength,
        },
      });

      totalDuration += audioLength;
      index++;
    }

    if (config.paddingBack) {
      totalDuration += config.paddingBack / 1000;
    }

    const selectedMusic = this.findMusic(totalDuration, config.music);
    logger.debug({ selectedMusic }, "Selected music for the video");

    // Render with FFmpeg (replaces Remotion/Chrome)
    await this.remotion.render(
      {
        music: selectedMusic,
        scenes,
        config: {
          durationMs: totalDuration * 1000,
          paddingBack: config.paddingBack,
          captionBackgroundColor: config.captionBackgroundColor,
          captionPosition: config.captionPosition,
          musicVolume: config.musicVolume,
        },
      },
      videoId,
      orientation,
    );

    // Upload rendered video to Supabase Storage
    const localVideoPath = this.getVideoPath(videoId);
    try {
      const videoUrl = await uploadVideo(videoId, localVideoPath);
      await markJobReady(videoId, videoUrl);
      logger.info({ videoId, videoUrl }, "Video uploaded to Supabase");
      // Clean up local file — it now lives in Supabase
      fs.removeSync(localVideoPath);
    } catch (uploadError: unknown) {
      logger.error(uploadError, "Supabase upload failed — video kept locally");
      // Still mark ready with a local fallback (won't survive restarts but better than failing)
      await markJobReady(videoId, `/api/short-video/${videoId}/local`).catch(() => {});
    }

    // Clean up temp files
    for (const file of tempFiles) {
      fs.removeSync(file);
    }

    return videoId;
  }

  public getVideoPath(videoId: string): string {
    return path.join(this.config.videosDirPath, `${videoId}.mp4`);
  }

  /** Returns the Supabase URL for a ready video, or null */
  public async getVideoUrl(videoId: string): Promise<string | null> {
    const job = await getJob(videoId);
    return job?.url ?? null;
  }

  public async deleteVideo(videoId: string): Promise<void> {
    // Delete from Supabase Storage
    await deleteVideoFromStorage(videoId).catch(() => {});
    // Delete DB record
    await deleteJob(videoId).catch(() => {});
    // Delete local file if still present
    const localPath = this.getVideoPath(videoId);
    fs.removeSync(localPath);
    logger.debug({ videoId }, "Deleted video");
  }

  public getVideo(videoId: string): Buffer {
    const videoPath = this.getVideoPath(videoId);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video ${videoId} not found locally`);
    }
    return fs.readFileSync(videoPath);
  }

  private findMusic(videoDuration: number, tag?: MusicMoodEnum): MusicForVideo {
    const musicFiles = this.musicManager.musicList().filter((music) => {
      if (tag) return music.mood === tag;
      return true;
    });
    return musicFiles[Math.floor(Math.random() * musicFiles.length)];
  }

  public ListAvailableMusicTags(): MusicTag[] {
    const tags = new Set<MusicTag>();
    this.musicManager.musicList().forEach((music) => {
      tags.add(music.mood as MusicTag);
    });
    return Array.from(tags.values());
  }

  public async listAllVideos(): Promise<{ id: string; status: VideoStatus; url?: string }[]> {
    try {
      const jobs = await listJobs();
      const inQueue = new Set(this.queue.map((q) => q.id));
      return jobs.map((job) => ({
        id: job.id,
        status: inQueue.has(job.id) ? "processing" : (job.status as VideoStatus),
        url: job.url,
      }));
    } catch {
      // Fallback: in-memory queue only
      return this.queue.map((q) => ({ id: q.id, status: "processing" as VideoStatus }));
    }
  }

  public ListAvailableVoices(): string[] {
    return this.kokoro.listAvailableVoices();
  }
}
