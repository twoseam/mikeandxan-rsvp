-- Day-of schedule v2: events instead of fixed slots, so one event can span
-- several half-hours and several events can share the same time.
-- start_slot/end_slot count half-hours from 8:00 AM (0 = 8:00 AM,
-- 32 = midnight, 33 = 12:30 AM). end_slot is exclusive.
CREATE TABLE schedule_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_slot INTEGER NOT NULL,
  end_slot   INTEGER NOT NULL,
  what       TEXT NOT NULL DEFAULT '',
  who        TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
-- Carry over anything already typed into the old one-row-per-slot version.
-- (Old table is left in place, untouched.)
INSERT INTO schedule_events (start_slot, end_slot, what, who, notes, updated_at)
  SELECT slot, slot + 1, what, who, notes, updated_at FROM schedule_slots;
