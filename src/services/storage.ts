import fs from "fs";
import { getSupabaseClient } from "../db/supabase";

const BUCKET = process.env.SUPABASE_BUCKET ?? "videos";

export async function uploadVideo(videoId: string, localPath: string): Promise<string> {
  const client = getSupabaseClient();
  const objectPath = `${videoId}.mp4`;

  // Stream instead of readFileSync — avoids holding entire video in RAM
  const fileStream = fs.createReadStream(localPath);

  const { error: uploadError } = await client.storage
    .from(BUCKET)
    .upload(objectPath, fileStream as any, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

  const { data } = client.storage.from(BUCKET).getPublicUrl(objectPath);
  if (data?.publicUrl) return data.publicUrl;

  const { data: signed, error: signedError } = await client.storage
    .from(BUCKET)
    .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

  if (signedError || !signed?.signedUrl)
    throw new Error(`Failed to get signed URL: ${signedError?.message}`);

  return signed.signedUrl;
}

export async function deleteVideoFromStorage(videoId: string): Promise<void> {
  const { error } = await getSupabaseClient().storage.from(BUCKET).remove([`${videoId}.mp4`]);
  if (error) throw new Error(`Supabase delete failed: ${error.message}`);
}
