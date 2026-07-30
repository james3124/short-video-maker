# Contributing

## Local development setup

### Requirements

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- System ffmpeg (`brew install ffmpeg` on Mac, `apt install ffmpeg` on Ubuntu)
- whisper.cpp binary compiled locally (see below)
- A running Kokoro TTS server (or use the public one in `.env.example`)
- Supabase project with `video_jobs` table and `videos` bucket (run `supabase-setup.sql`)

### Setup

```bash
git clone https://github.com/your-fork/short-video-maker.git
cd short-video-maker
pnpm install
cp .env.example .env
# fill in your keys in .env
```

### Build whisper.cpp locally

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp && git checkout v1.7.1
make -j$(nproc)
cd models && sh ./download-ggml-model.sh tiny.en
```

Then add to your `.env`:
```
WHISPER_BINARY=/path/to/whisper.cpp/main
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-tiny.en.bin
```

### Run

```bash
pnpm dev
```

### Build

```bash
pnpm build
pnpm start
```

### Docker build

```bash
docker build -f Dockerfile.ultra -t short-video-maker:ultra .
docker run -it --rm -p 3123:3123 --env-file .env short-video-maker:ultra
```

### Tests

```bash
pnpm test
```

## Architecture

```
src/
  index.ts                      — entrypoint, wires everything together
  config.ts                     — env var config
  logger.ts                     — pino logger
  types/shorts.ts               — shared TypeScript types and Zod schemas

  short-creator/
    ShortCreator.ts             — main orchestrator (queue, render, upload)
    music.ts                    — music file registry
    libraries/
      Kokoro.ts                 — HTTP client to external Kokoro TTS API
      Whisper.ts                — whisper.cpp subprocess wrapper
      Remotion.ts               — FFmpeg video compositing (replaces Remotion/Chrome)
      FFmpeg.ts                 — audio helpers (normalize, mp3)
      Pexels.ts                 — Pexels video search

  server/
    server.ts                   — Express server setup
    routers/rest.ts             — REST API routes
    routers/mcp.ts              — MCP server routes
    validator.ts                — Zod input validation

  db/
    supabase.ts                 — Supabase client + video_jobs CRUD

  services/
    storage.ts                  — Supabase Storage upload/delete
```

## Key design decisions

- **No Chromium** — Remotion/Chrome removed entirely. FFmpeg handles all compositing via `filter_complex` with the `subtitles` filter for caption rendering.
- **External TTS** — kokoro-js removed. TTS is a single HTTP POST to your Kokoro server. Swap the `KOKORO_API_URL` to point to any compatible server.
- **Supabase for persistence** — Render's filesystem is ephemeral. All finished videos live in Supabase Storage; job status is in the `video_jobs` table. Survives restarts/redeploys.
- **Same public API** — REST and MCP interfaces are unchanged. Existing n8n workflows require no edits.
