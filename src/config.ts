import path from "path";
import "dotenv/config";
import os from "os";
import fs from "fs-extra";
import pino from "pino";
import { whisperModels } from "./types/shorts";

const defaultLogLevel: pino.Level = "info";
const defaultPort = 3123;

const versionNumber = process.env.npm_package_version;
export const logger = pino({
  level: process.env.LOG_LEVEL || defaultLogLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  base: { pid: process.pid, version: versionNumber },
});

export class Config {
  private dataDirPath: string;
  private libsDirPath: string;
  private staticDirPath: string;

  public installationSuccessfulPath: string;
  public whisperInstallPath: string;   // whisper binary directory
  public videosDirPath: string;
  public tempDirPath: string;
  public packageDirPath: string;
  public musicDirPath: string;

  public pexelsApiKey: string;
  public logLevel: pino.Level;
  public whisperVerbose: boolean;
  public port: number;
  public runningInDocker: boolean;
  public devMode: boolean;

  // Whisper — version kept for compat, model used for path construction
  public whisperVersion: string = "1.7.1";
  public whisperModel: whisperModels = "tiny.en";

  // Supabase
  public supabaseUrl: string;
  public supabaseServiceKey: string;
  public supabaseBucket: string;

  // Kokoro (external API)
  public kokoroApiUrl: string;

  constructor() {
    this.dataDirPath =
      process.env.DATA_DIR_PATH ||
      path.join(os.homedir(), ".ai-agents-az-video-generator");
    this.libsDirPath = path.join(this.dataDirPath, "libs");

    // In Docker: binary at /app/bin/whisper, model at /app/data/libs/whisper/models/
    // Locally: binary compiled into libs/whisper by whisper install
    this.whisperInstallPath = path.join(this.libsDirPath, "whisper");
    this.videosDirPath = path.join(this.dataDirPath, "videos");
    this.tempDirPath = path.join(this.dataDirPath, "temp");
    this.installationSuccessfulPath = path.join(this.dataDirPath, "installation-successful");

    fs.ensureDirSync(this.dataDirPath);
    fs.ensureDirSync(this.libsDirPath);
    fs.ensureDirSync(this.videosDirPath);
    fs.ensureDirSync(this.tempDirPath);

    this.packageDirPath = path.join(__dirname, "..");
    this.staticDirPath = path.join(this.packageDirPath, "static");
    this.musicDirPath = path.join(this.staticDirPath, "music");

    this.pexelsApiKey = process.env.PEXELS_API_KEY as string;
    this.logLevel = (process.env.LOG_LEVEL || defaultLogLevel) as pino.Level;
    this.whisperVerbose = process.env.WHISPER_VERBOSE === "true";
    this.port = process.env.PORT ? parseInt(process.env.PORT) : defaultPort;
    this.runningInDocker = process.env.DOCKER === "true";
    this.devMode = process.env.DEV === "true";

    if (process.env.WHISPER_MODEL) {
      this.whisperModel = process.env.WHISPER_MODEL as whisperModels;
    }

    // Supabase
    this.supabaseUrl = process.env.SUPABASE_URL ?? "";
    this.supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY ?? "";
    this.supabaseBucket = process.env.SUPABASE_BUCKET ?? "videos";

    // Kokoro external API
    this.kokoroApiUrl =
      process.env.KOKORO_API_URL ?? "https://kokoro-tts-tfeq.onrender.com";
  }

  public ensureConfig() {
    if (!this.pexelsApiKey) {
      throw new Error(
        "PEXELS_API_KEY environment variable is missing. Get your free API key: https://www.pexels.com/api/key/",
      );
    }
    if (!this.supabaseUrl || !this.supabaseServiceKey) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. See supabase-setup.sql to create the required table.",
      );
    }
  }
}
