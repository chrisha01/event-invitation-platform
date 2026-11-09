-- Hosted PostgreSQL schema. Local SQLite remains the compatibility backend.
CREATE TABLE IF NOT EXISTS hosts (
  id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, host_id BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, host_id BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  event_date DATE NOT NULL, event_start_time TEXT, event_end_time TEXT, event_timezone TEXT,
  location TEXT NOT NULL DEFAULT '', guest_mode TEXT NOT NULL CHECK (guest_mode IN ('individual','household')),
  rsvp_deadline TIMESTAMPTZ, capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  responses_open BOOLEAN NOT NULL DEFAULT TRUE, reopened_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','postponed','cancelled')),
  status_note TEXT, replacement_event_date DATE, replacement_event_start_time TEXT,
  replacement_event_end_time TEXT, replacement_event_timezone TEXT, created_at TIMESTAMPTZ NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE, theme_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  invitation_settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  invitation_copy_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS guest_units (
  id BIGSERIAL PRIMARY KEY, event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT, group_name TEXT, party_limit INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  invite_url TEXT NOT NULL DEFAULT '', revoked_at TIMESTAMPTZ, walk_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS rsvps (
  id BIGSERIAL PRIMARY KEY, guest_unit_id BIGINT NOT NULL UNIQUE REFERENCES guest_units(id) ON DELETE CASCADE,
  answer TEXT NOT NULL, party_size INTEGER NOT NULL, contact_phone TEXT, contact_updates BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS rsvp_attendees (
  id BIGSERIAL PRIMARY KEY, guest_unit_id BIGINT NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
  name TEXT NOT NULL, dietary TEXT NOT NULL DEFAULT '', accessibility TEXT NOT NULL DEFAULT '',
  age_band TEXT NOT NULL DEFAULT 'adult' CHECK (age_band IN ('adult','child')),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGSERIAL PRIMARY KEY, guest_unit_id BIGINT NOT NULL REFERENCES guest_units(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS local_messages (
  id BIGSERIAL PRIMARY KEY, event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_unit_id BIGINT REFERENCES guest_units(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS check_ins (
  id BIGSERIAL PRIMARY KEY, event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_unit_id BIGINT REFERENCES guest_units(id) ON DELETE CASCADE,
  attendee_id BIGINT REFERENCES rsvp_attendees(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ NOT NULL, reversed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS seating_plans (
  id BIGSERIAL PRIMARY KEY, event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  algorithm_version TEXT NOT NULL DEFAULT 'heuristic-1', seed INTEGER NOT NULL DEFAULT 1,
  input_hash TEXT NOT NULL DEFAULT '', score INTEGER NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb, venue_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  floor_plan_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, published_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS seating_tables (
  id BIGSERIAL PRIMARY KEY, plan_id BIGINT NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
  name TEXT NOT NULL, capacity INTEGER NOT NULL, shape TEXT NOT NULL DEFAULT 'round',
  rotation INTEGER NOT NULL DEFAULT 0,
  position_x DOUBLE PRECISION NOT NULL DEFAULT 50, position_y DOUBLE PRECISION NOT NULL DEFAULT 50,
  initial_position_x DOUBLE PRECISION NOT NULL DEFAULT 50, initial_position_y DOUBLE PRECISION NOT NULL DEFAULT 50,
  sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seating_assignments (
  plan_id BIGINT NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
  attendee_id BIGINT NOT NULL REFERENCES rsvp_attendees(id) ON DELETE CASCADE,
  table_id BIGINT NOT NULL REFERENCES seating_tables(id) ON DELETE CASCADE,
  seat_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, attendee_id)
);
CREATE TABLE IF NOT EXISTS seating_constraints (
  id BIGSERIAL PRIMARY KEY, plan_id BIGINT NOT NULL REFERENCES seating_plans(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL, relationship TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'preferred', attendee_ids_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS guest_units_event_id_idx ON guest_units(event_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS seating_plans_event_id_idx ON seating_plans(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS check_ins_guest_active_idx
  ON check_ins(guest_unit_id) WHERE guest_unit_id IS NOT NULL AND reversed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS check_ins_attendee_active_idx
  ON check_ins(attendee_id) WHERE attendee_id IS NOT NULL AND reversed_at IS NULL;
