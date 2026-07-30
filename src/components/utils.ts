import z from "zod";
import { OrientationEnum } from "../types/shorts";

// Returns the required video dimensions for a given orientation
// Used by Pexels.ts to filter videos by resolution
export function getOrientationConfig(orientation: OrientationEnum): {
  width: number;
  height: number;
} {
  if (orientation === OrientationEnum.landscape) {
    return { width: 1920, height: 1080 };
  }
  // portrait (default)
  return { width: 1080, height: 1920 };
}

// ── Zod schemas used by Remotion.ts render() signature ────────────────────────

export const captionSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const sceneSchema = z.object({
  captions: z.array(captionSchema),
  video: z.string(),
  audio: z.object({
    url: z.string(),
    duration: z.number(),
  }),
});

export const shortVideoSchema = z.object({
  music: z
    .object({
      file: z.string(),
      start: z.number().optional(),
      end: z.number().optional(),
      mood: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  scenes: z.array(sceneSchema),
  config: z.object({
    durationMs: z.number(),
    paddingBack: z.number().optional(),
    captionBackgroundColor: z.string().optional(),
    captionPosition: z.string().optional(),
    musicVolume: z.string().optional(),
  }),
});
