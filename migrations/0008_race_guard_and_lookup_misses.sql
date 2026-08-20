-- One response per household, enforced by the database itself: two
-- simultaneous submits (double-tap, both partners at once) can't both land.
-- The loser fails cleanly into the submission_log safety net.
CREATE UNIQUE INDEX idx_rsvps_one_per_household ON rsvps(household_id);

-- Name searches that found nobody — the silent way to lose an RSVP
-- (nicknames, maiden names, typos). Reported in the daily audit email.
CREATE TABLE lookup_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  searched_at TEXT NOT NULL,
  query TEXT NOT NULL
);
