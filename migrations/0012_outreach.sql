-- Reminder page: a log of every time Michael reached out to a household
-- that hasn't RSVP'd (text / call / email / in person), each with a date
-- and an optional note. Replaces the single reminded_at check-off as the
-- source of truth; reminded_at stays on households for history only.
CREATE TABLE household_outreach (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  method       TEXT NOT NULL,
  note         TEXT,
  contacted_at TEXT NOT NULL
);
CREATE INDEX idx_household_outreach_household ON household_outreach(household_id);

-- Carry over the existing "Texted" check-offs so nothing is lost.
INSERT INTO household_outreach (household_id, method, note, contacted_at)
  SELECT id, 'text', NULL, reminded_at FROM households WHERE reminded_at IS NOT NULL;
