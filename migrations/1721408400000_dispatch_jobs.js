module.exports = {
  name: 'dispatch_jobs',
  up: async (client) => {
    // Cloud side of the outbound desktop-agent bridge. The dashboard ("Command
    // Otto") creates a job; a local Arcade watcher leases it, runs Claude locally,
    // and returns a draft (approval-gated). No inbound connection to the Mac.
    await client.query(`
      create table if not exists dispatch_jobs (
        id uuid primary key default gen_random_uuid(),
        capability text not null,               -- e.g. content.draft_recap
        payload jsonb not null default '{}',
        status text not null default 'queued',  -- queued|claimed|running|awaiting_approval|succeeded|failed|canceled|expired
        allowed_projects text[] default '{}',
        result jsonb,
        error text,
        lease_owner text,
        lease_expires_at timestamptz,
        created_by text,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      )`);
    await client.query(`create index if not exists dispatch_jobs_status_idx on dispatch_jobs (status, created_at)`);
    // Known agent devices (heartbeat + last-seen; v1 shares AGENT_KEY, keypair later).
    await client.query(`
      create table if not exists agent_devices (
        device_id text primary key, name text, last_seen timestamptz
      )`);
  },
};
