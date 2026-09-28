// Applied on every startup, so each statement must be idempotent.
export const SCHEMA_SQL = `
CREATE SEQUENCE IF NOT EXISTS sync_version;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- client_id is the id the app generated; uid is the stable public id.
-- updated_at is the client's edit time (ms) used for last-write-wins;
-- version is a server-wide counter used as the sync cursor.
CREATE TABLE IF NOT EXISTS courses (
  uid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  name text NOT NULL,
  hole_count integer NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  layouts jsonb NOT NULL DEFAULT '[]',
  published boolean NOT NULL DEFAULT false,
  city text,
  state text,
  latitude double precision,
  longitude double precision,
  updated_at bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT nextval('sync_version'),
  UNIQUE (owner_id, client_id)
);
CREATE INDEX IF NOT EXISTS courses_owner_version ON courses (owner_id, version);
CREATE INDEX IF NOT EXISTS courses_published ON courses (published) WHERE published AND NOT deleted;

CREATE TABLE IF NOT EXISTS rounds (
  uid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  course_client_id text,
  course_name text NOT NULL,
  mode text NOT NULL,
  shots jsonb NOT NULL DEFAULT '[]',
  shared boolean NOT NULL DEFAULT false,
  share_token text UNIQUE,
  updated_at bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT nextval('sync_version'),
  UNIQUE (owner_id, client_id)
);
CREATE INDEX IF NOT EXISTS rounds_owner_version ON rounds (owner_id, version);

CREATE TABLE IF NOT EXISTS bags (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discs jsonb NOT NULL DEFAULT '[]',
  details jsonb NOT NULL DEFAULT '{}',
  updated_at bigint NOT NULL,
  version bigint NOT NULL DEFAULT nextval('sync_version')
);
`;
