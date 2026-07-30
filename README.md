# Short Video Maker — Ultra Slim Fork

An open source automated video creation tool for generating short-form video content. This fork strips the image down from **~1.2 GB to ~270 MB** by replacing Chromium/Remotion with pure FFmpeg and offloading TTS to an external Kokoro API server.

The server exposes an [MCP](https://github.com/modelcontextprotocol) and a REST API, fully compatible with the original — existing n8n workflows need no changes.

---

## What changed from the original

| Component | Original | This fork |
|---|---|---|
| Video rendering | Remotion + Chromium | Pure FFmpeg |
| Text-to-speech | kokoro-js (bundled model) | External Kokoro API |
| Video storage | Local disk | Supabase Storage |
| Job status | In-memory | Supabase DB |
| Docker image size | ~1.2 GB | ~270 MB |
| RAM at runtime | ~1.5–2 GB | ~600 MB |

---

## How it works

1. **Text → Speech** — POST to external Kokoro TTS API → audio file
2. **Audio → Captions** — whisper.cpp (tiny.en, pre-built in image) → SRT file
3. **Background video** — Pexels API → downloaded to temp dir
4. **Compositing** — FFmpeg: scale bg video + burn-in captions + mix music → MP4 per scene
5. **Concat + music** — FFmpeg: join all scene clips + amix background music
6. **Upload** — Supabase Storage → returns public URL
7. **Status tracking** — Supabase `video_jobs` table

---

## Requirements

- Pexels API key (free) — https://www.pexels.com/api/
- Supabase project (free tier works) — https://supabase.com
- An external Kokoro TTS server — e.g. `https://kokoro-tts-tfeq.onrender.com`
- Docker (recommended) or Node.js 22+ with system ffmpeg

---

## Quick start with Docker

### 1. Set up Supabase

Run `supabase-setup.sql` in your Supabase project's SQL editor, then create a Storage bucket named `videos` (set to **Public**).

### 2. Environment variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
PEXELS_API_KEY=your_pexels_api_key_here
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
SUPABASE_BUCKET=videos
KOKORO_API_URL=https://kokoro-tts-tfeq.onrender.com
```

### 3. Build and run

```bash
docker build -f Dockerfile.ultra -t short-video-maker:ultra .

docker run -it --rm \
  -p 3123:3123 \
  --env-file .env \
  short-video-maker:ultra
```

Or with Docker Compose:

```bash
docker compose up --build
```

---

## Deploying to Render.com

1. Push your image to Docker Hub:
   ```bash
   docker buildx build \
     --platform linux/amd64 \
     -f Dockerfile.ultra \
     -t yourname/short-video-maker:ultra \
     --push .
   ```

2. Create a new **Web Service** on Render → **Deploy an existing image**

3. Set the plan to **Standard ($25/mo, 2 GB RAM)** — the free/starter tier OOMs during FFmpeg compositing

4. Add environment variables from `.env.example` in the Render dashboard

5. Set the port to `3123`

The server URL (e.g. `https://your-app.onrender.com`) is what you point n8n at.

---

## Environment variables

### Required

| Key | Description |
|---|---|
| `PEXELS_API_KEY` | Free Pexels API key — https://www.pexels.com/api/ |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (not the anon key) |
| `KOKORO_API_URL` | Base URL of your external Kokoro TTS server |

### Optional

| Key | Description | Default |
|---|---|---|
| `SUPABASE_BUCKET` | Supabase Storage bucket name | `videos` |
| `KOKORO_VOICE` | Default TTS voice | `af_heart` |
| `KOKORO_SPEED` | TTS speed multiplier | `1` |
| `KOKORO_LANG_CODE` | Language code passed to Kokoro | `a` |
| `WHISPER_MODEL` | Whisper model size | `tiny.en` |
| `WHISPER_VERBOSE` | Forward whisper output to stdout | `false` |
| `PORT` | HTTP port | `3123` |
| `LOG_LEVEL` | pino log level | `info` |
| `DATA_DIR_PATH` | Data directory | `/app/data` (Docker) |

---

## Configuration options (per video request)

| Key | Description | Default |
|---|---|---|
| `paddingBack` | Silence after narration ends, in milliseconds | `0` |
| `music` | Background music mood. See `GET /api/music-tags` | random |
| `musicVolume` | Music volume: `muted`, `low`, `medium`, `high` | `high` |
| `captionPosition` | Caption placement: `top`, `center`, `bottom` | `bottom` |
| `captionBackgroundColor` | Caption background color (CSS color or hex) | `blue` |
| `voice` | Kokoro voice name | `af_heart` |
| `orientation` | Video orientation: `portrait`, `landscape` | `portrait` |

---

## REST API

All endpoints are identical to the original. The only behaviour difference is `GET /api/short-video/:id` now returns a **302 redirect** to a Supabase URL instead of streaming bytes — most HTTP clients (including n8n's HTTP Request node) follow redirects automatically.

### POST `/api/short-video`

```bash
curl -X POST http://localhost:3123/api/short-video \
  -H "Content-Type: application/json" \
  -d '{
    "scenes": [
      {
        "text": "Hello world! This is my first short video.",
        "searchTerms": ["ocean", "waves", "sunset"]
      }
    ],
    "config": {
      "paddingBack": 1500,
      "music": "chill",
      "captionPosition": "bottom",
      "voice": "af_heart",
      "orientation": "portrait"
    }
  }'
```

```json
{ "videoId": "cma9sjly700020jo25vwzfnv9" }
```

### GET `/api/short-video/:id/status`

```bash
curl http://localhost:3123/api/short-video/cma9sjly700020jo25vwzfnv9/status
```

```json
{ "status": "ready" }
```

Status values: `processing` | `ready` | `failed`

### GET `/api/short-video/:id`

Returns a **302 redirect** to the Supabase Storage URL of the rendered video.

```bash
curl -L http://localhost:3123/api/short-video/cma9sjly700020jo25vwzfnv9
# → follows redirect → streams the MP4
```

### GET `/api/short-videos`

```bash
curl http://localhost:3123/api/short-videos
```

```json
{
  "videos": [
    { "id": "cma9sjly700020jo25vwzfnv9", "status": "ready", "url": "https://xxxx.supabase.co/storage/v1/object/public/videos/cma9sjly700020jo25vwzfnv9.mp4" }
  ]
}
```

### DELETE `/api/short-video/:id`

Deletes from both Supabase Storage and the `video_jobs` table.

```bash
curl -X DELETE http://localhost:3123/api/short-video/cma9sjly700020jo25vwzfnv9
```

```json
{ "success": true }
```

### GET `/api/voices`

Returns available Kokoro voice names.

### GET `/api/music-tags`

Returns available music moods: `sad`, `melancholic`, `happy`, `euphoric/high`, `excited`, `chill`, `uneasy`, `angry`, `dark`, `hopeful`, `contemplative`, `funny/quirky`

### GET `/health`

```json
{ "status": "ok" }
```

---

## MCP server

Endpoints: `/mcp/sse` and `/mcp/messages`

Available tools:
- `create-short-video` — creates a short video
- `get-video-status` — checks render status

---

## Concepts

### Scene

Each video is assembled from one or more scenes. Each scene has:

1. **text** — the narration that gets spoken and captioned
2. **searchTerms** — keywords for Pexels background video search (2–3 terms recommended). Falls back to joker terms (`nature`, `ocean`, `space`, `globe`) if nothing is found.

---

## Using with n8n

Point your n8n HTTP Request node or MCP client at your Render URL. The API is identical to the original.

| n8n location | short-video-maker location | URL to use |
|---|---|---|
| Local | Local Docker | `http://localhost:3123` |
| Local Docker | Local Docker (same compose) | `http://short-video-maker:3123` |
| n8n cloud | Render.com | `https://your-app.onrender.com` |

---

## Dependencies

| Dependency | Version | License | Purpose |
|---|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | v1.7.1 | MIT | Speech-to-text captions |
| [FFmpeg](https://ffmpeg.org/) | system | LGPL/GPL | Video compositing + audio mixing |
| [Kokoro TTS](https://github.com/hexgrad/kokoro) | external API | MIT | Text-to-speech |
| [Pexels API](https://www.pexels.com/api/) | N/A | Pexels Terms | Background videos |
| [Supabase](https://supabase.com) | ^2.45.0 | Apache 2.0 | Storage + job tracking |

---

## Limitations

- English voiceover only (Kokoro constraint)
- Background videos sourced from Pexels only
- Caption styling is rendered via FFmpeg `subtitles` filter — word-level highlight colour is not supported (solid background colour per caption segment instead)
- Windows is **not supported** for local development (whisper.cpp build)

---

## License

MIT — see [LICENSE](LICENSE)
