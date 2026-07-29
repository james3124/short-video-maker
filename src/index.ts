import path from "path";
import fs from "fs-extra";

import { Kokoro } from "./short-creator/libraries/Kokoro";
import { Remotion } from "./short-creator/libraries/Remotion";
import { Whisper } from "./short-creator/libraries/Whisper";
import { FFMpeg } from "./short-creator/libraries/FFmpeg";
import { PexelsAPI } from "./short-creator/libraries/Pexels";
import { Config } from "./config";
import { ShortCreator } from "./short-creator/ShortCreator";
import { logger } from "./logger";
import { Server } from "./server/server";
import { MusicManager } from "./short-creator/music";

async function main() {
  const config = new Config();
  try {
    config.ensureConfig();
  } catch (err: unknown) {
    logger.error(err, "Error in config");
    process.exit(1);
  }

  const musicManager = new MusicManager(config);
  try {
    logger.debug("checking music files");
    musicManager.ensureMusicFilesExist();
  } catch (error: unknown) {
    logger.error(error, "Missing music files");
    process.exit(1);
  }

  // No Chromium download — FFmpeg renderer init is instant
  logger.debug("initializing renderer (FFmpeg)");
  const remotion = await Remotion.init(config);

  // No local model download — uses external Kokoro API
  logger.debug("initializing Kokoro (external API)");
  const kokoro = await Kokoro.init();

  // Whisper binary must already be installed (pre-built in Docker)
  logger.debug("initializing whisper");
  const whisper = await Whisper.init(config);

  logger.debug("initializing ffmpeg");
  const ffmpeg = await FFMpeg.init();

  const pexelsApi = new PexelsAPI(config.pexelsApiKey);

  logger.debug("initializing the short creator");
  const shortCreator = new ShortCreator(
    config,
    remotion,
    kokoro,
    whisper,
    ffmpeg,
    pexelsApi,
    musicManager,
  );

  logger.debug("initializing the server");
  const server = new Server(config, shortCreator);
  server.start();
}

main().catch((error: unknown) => {
  logger.error(error, "Error starting server");
});
