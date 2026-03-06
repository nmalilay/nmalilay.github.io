create table if not exists public.site_content_blocks (
  path text not null,
  block_id text not null,
  html text not null default '',
  client_id text,
  updated_at timestamptz not null default now(),
  primary key (path, block_id)
);

alter table public.site_content_blocks enable row level security;

drop policy if exists "public read site content blocks" on public.site_content_blocks;
create policy "public read site content blocks"
on public.site_content_blocks
for select
to anon, authenticated
using (true);

drop policy if exists "public insert site content blocks" on public.site_content_blocks;
create policy "public insert site content blocks"
on public.site_content_blocks
for insert
to anon, authenticated
with check (true);

drop policy if exists "public update site content blocks" on public.site_content_blocks;
create policy "public update site content blocks"
on public.site_content_blocks
for update
to anon, authenticated
using (true)
with check (true);

do $$
begin
  if not exists (
    select 1
    from pg_publication_rel pr
    join pg_class c on c.oid = pr.prrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_publication p on p.oid = pr.prpubid
    where p.pubname = 'supabase_realtime'
      and n.nspname = 'public'
      and c.relname = 'site_content_blocks'
  ) then
    alter publication supabase_realtime add table public.site_content_blocks;
  end if;
end
$$;
