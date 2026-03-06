# Supabase Setup

This site now supports shared inline text editing through Supabase.

## What this enables

- Visitors can click body text and edit it directly.
- Changes are written to Supabase and sync live across visitors on the same page.
- If Supabase is not configured or unavailable, the editor falls back to browser-local storage.

## Files

- Config: `/Users/nick/Documents/GitHub/nmalilay.github.io/scripts/supabase_config.js`
- SQL schema/policies: `/Users/nick/Documents/GitHub/nmalilay.github.io/scripts/supabase_schema.sql`
- Editor runtime: `/Users/nick/Documents/GitHub/nmalilay.github.io/scripts/inline_editor.js`

## Supabase steps

1. Create a Supabase project.
2. Open the SQL editor in Supabase.
3. Run the SQL from `/Users/nick/Documents/GitHub/nmalilay.github.io/scripts/supabase_schema.sql`.
4. Open Project Settings -> API.
5. Copy the project URL and anon public key.
6. Edit `/Users/nick/Documents/GitHub/nmalilay.github.io/scripts/supabase_config.js`:

```js
window.__INLINE_EDITOR_SUPABASE__ = {
  enabled: true,
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_ANON_PUBLIC_KEY",
  schema: "public",
  table: "site_content_blocks",
  realtime: true,
  saveDebounceMs: 400,
};
```

7. Publish the updated site.

## Security warning

The current SQL policies intentionally allow anonymous public read and write access because the goal was "anyone on the internet can click and edit text."

That means:

- anyone can vandalize the site text
- anyone can overwrite other edits
- bots can spam the content

For a safer version, replace the public insert/update policies with authenticated-only or password-gated editing.
