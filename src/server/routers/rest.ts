import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import fs from "fs-extra";
import path from "path";

import { validateCreateShortInput } from "../validator";
import { ShortCreator } from "../../short-creator/ShortCreator";
import { logger } from "../../logger";
import { Config } from "../../config";

export class APIRouter {
  public router: express.Router;
  private shortCreator: ShortCreator;
  private config: Config;

  constructor(config: Config, shortCreator: ShortCreator) {
    this.config = config;
    this.router = express.Router();
    this.shortCreator = shortCreator;
    this.router.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes() {
    // POST /api/short-video — create a video
    this.router.post("/short-video", async (req: ExpressRequest, res: ExpressResponse) => {
      try {
        const input = validateCreateShortInput(req.body);
        logger.info({ input }, "Creating short video");
        const videoId = this.shortCreator.addToQueue(input.scenes, input.config);
        res.status(201).json({ videoId });
      } catch (error: unknown) {
        logger.error(error, "Error validating input");
        if (error instanceof Error && error.message.startsWith("{")) {
          try {
            const errorData = JSON.parse(error.message);
            res.status(400).json({ error: "Validation failed", message: errorData.message, missingFields: errorData.missingFields });
            return;
          } catch (_) {}
        }
        res.status(400).json({ error: "Invalid input", message: error instanceof Error ? error.message : "Unknown error" });
      }
    });

    // GET /api/short-video/:videoId/status
    this.router.get("/short-video/:videoId/status", async (req: ExpressRequest, res: ExpressResponse) => {
      const { videoId } = req.params;
      if (!videoId) { res.status(400).json({ error: "videoId is required" }); return; }
      const status = await this.shortCreator.status(videoId);
      res.status(200).json({ status });
    });

    // GET /api/short-video/:videoId — redirect to Supabase URL
    this.router.get("/short-video/:videoId", async (req: ExpressRequest, res: ExpressResponse) => {
      try {
        const { videoId } = req.params;
        if (!videoId) { res.status(400).json({ error: "videoId is required" }); return; }

        const url = await this.shortCreator.getVideoUrl(videoId);
        if (url) {
          // Redirect to Supabase Storage URL
          res.redirect(302, url);
          return;
        }

        // Fallback: try to serve from local disk (dev mode / upload failed)
        const video = this.shortCreator.getVideo(videoId);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `inline; filename=${videoId}.mp4`);
        res.send(video);
      } catch (error: unknown) {
        logger.error(error, "Error getting video");
        res.status(404).json({ error: "Video not found" });
      }
    });

    // GET /api/short-videos
    this.router.get("/short-videos", async (req: ExpressRequest, res: ExpressResponse) => {
      const videos = await this.shortCreator.listAllVideos();
      res.status(200).json({ videos });
    });

    // DELETE /api/short-video/:videoId
    this.router.delete("/short-video/:videoId", async (req: ExpressRequest, res: ExpressResponse) => {
      const { videoId } = req.params;
      if (!videoId) { res.status(400).json({ error: "videoId is required" }); return; }
      await this.shortCreator.deleteVideo(videoId);
      res.status(200).json({ success: true });
    });

    // GET /api/music-tags
    this.router.get("/music-tags", (req: ExpressRequest, res: ExpressResponse) => {
      res.status(200).json(this.shortCreator.ListAvailableMusicTags());
    });

    // GET /api/voices
    this.router.get("/voices", (req: ExpressRequest, res: ExpressResponse) => {
      res.status(200).json(this.shortCreator.ListAvailableVoices());
    });

    // GET /api/tmp/:tmpFile — used internally by FFmpeg renderer
    this.router.get("/tmp/:tmpFile", (req: ExpressRequest, res: ExpressResponse) => {
      const { tmpFile } = req.params;
      if (!tmpFile) { res.status(400).json({ error: "tmpFile is required" }); return; }

      // Security: prevent path traversal
      const tmpFilePath = path.resolve(this.config.tempDirPath, tmpFile);
      if (!tmpFilePath.startsWith(path.resolve(this.config.tempDirPath))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!fs.existsSync(tmpFilePath)) { res.status(404).json({ error: "tmpFile not found" }); return; }

      if (tmpFile.endsWith(".mp3")) res.setHeader("Content-Type", "audio/mpeg");
      if (tmpFile.endsWith(".wav")) res.setHeader("Content-Type", "audio/wav");
      if (tmpFile.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");

      fs.createReadStream(tmpFilePath)
        .on("error", (err) => { logger.error(err, "Error reading tmp file"); res.status(500).json({ error: "Error reading tmp file" }); })
        .pipe(res);
    });

    // GET /api/music/:fileName
    this.router.get("/music/:fileName", (req: ExpressRequest, res: ExpressResponse) => {
      const { fileName } = req.params;
      if (!fileName) { res.status(400).json({ error: "fileName is required" }); return; }

      // Security: prevent path traversal
      const musicFilePath = path.resolve(this.config.musicDirPath, fileName);
      if (!musicFilePath.startsWith(path.resolve(this.config.musicDirPath))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!fs.existsSync(musicFilePath)) { res.status(404).json({ error: "music file not found" }); return; }

      fs.createReadStream(musicFilePath)
        .on("error", (err) => { logger.error(err, "Error reading music file"); res.status(500).json({ error: "Error reading music file" }); })
        .pipe(res);
    });
  }
}
