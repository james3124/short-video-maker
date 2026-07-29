import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type VideoStatus = "processing" | "ready" | "error";

export interface VideoJob {
  id: string;
  status: VideoStatus;
  url?: string;
  error?: string;
  created_at?: string;
}

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export async function createJob(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("video_jobs").insert({ id, status: "processing" });
  if (error) throw new Error(`createJob failed: ${error.message}`);
}

export async function markJobReady(id: string, url: string): Promise<void> {
  const { error } = await getSupabaseClient().from("video_jobs").update({ status: "ready", url }).eq("id", id);
  if (error) throw new Error(`markJobReady failed: ${error.message}`);
}

export async function markJobError(id: string, message: string): Promise<void> {
  const { error } = await getSupabaseClient().from("video_jobs").update({ status: "error", error: message }).eq("id", id);
  if (error) throw new Error(`markJobError failed: ${error.message}`);
}

export async function getJob(id: string): Promise<VideoJob | null> {
  const { data, error } = await getSupabaseClient().from("video_jobs").select("*").eq("id", id).single();
  if (error) return null;
  return data as VideoJob;
}

export async function listJobs(): Promise<VideoJob[]> {
  const { data, error } = await getSupabaseClient()
    .from("video_jobs")
    .select("id, status, url, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`listJobs failed: ${error.message}`);
  return (data ?? []) as VideoJob[];
}

export async function deleteJob(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("video_jobs").delete().eq("id", id);
  if (error) throw new Error(`deleteJob failed: ${error.message}`);
}
