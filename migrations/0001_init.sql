-- Households: a mailing address + a display group label. A household with
-- no address is a "solo" invite (no one else grouped with them).
CREATE TABLE households (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT,
  address TEXT
);

-- Guests: named people belonging to a household. Plus-one slots are a real
-- row here (is_plus_one = 1) so they show up in the guest list even before
-- anyone claims them.
CREATE TABLE guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_plus_one INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_guests_household ON guests(household_id);

-- One row per RSVP submission for a household (household_id is known
-- directly at submit time — no more inferring it by matching names).
CREATE TABLE rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  submitted_at TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  contact_method TEXT NOT NULL,
  song_request TEXT,
  pizza_topping TEXT,
  notes TEXT
);
CREATE INDEX idx_rsvps_household ON rsvps(household_id);

-- Per-guest response within one RSVP submission. guest_name is the actual
-- name recorded (a claimed +1 is recorded under their real name here).
CREATE TABLE rsvp_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  guest_name TEXT NOT NULL,
  attending INTEGER NOT NULL,
  dietary TEXT,
  dietary_other TEXT,
  is_plus_one INTEGER NOT NULL DEFAULT 0,
  bringing_plus_one TEXT
);
CREATE INDEX idx_rsvp_guests_rsvp ON rsvp_guests(rsvp_id);

-- Admin sessions — a signed token could work without this table, but a real
-- table lets Michael see/revoke active logins and survives a secret rotation
-- without silently invalidating already-issued tokens.
CREATE TABLE admin_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
