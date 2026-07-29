-- Run once in Supabase SQL editor
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists video_jobs (
  id          text primary key,
  status      text not null default 'processing'
                check (status in ('processing', 'ready', 'error')),
  url         text,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists video_jobs_created_at_idx on video_jobs (created_at desc);

alter table video_jobs enable row level security;

create policy "service role full access" on video_jobs
  using (true) with check (true);

-- Create storage bucket in Supabase Dashboard → Storage → New Bucket
-- Name: videos, Public: true
