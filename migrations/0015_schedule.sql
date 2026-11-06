-- Day-of schedule: the wedding day in 30-minute slots, 8 AM to midnight.
-- slot 0 = 8:00 AM, slot 1 = 8:30 AM ... slot 31 = 11:30 PM.
-- No row = nothing planned in that slot yet.
CREATE TABLE schedule_slots (
  slot       INTEGER PRIMARY KEY,
  what       TEXT NOT NULL DEFAULT '',
  who        TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
