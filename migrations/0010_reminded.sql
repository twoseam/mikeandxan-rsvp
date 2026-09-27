-- Reminder checklist: when Michael checked this household off as texted
-- an RSVP reminder. NULL = not yet texted. Same timestamp-not-flag shape
-- as mailed_at (0003) so unchecking is just setting it back to NULL.
ALTER TABLE households ADD COLUMN reminded_at TEXT;

-- Cell number Michael typed in himself for a household that hasn't
-- RSVP'd (the RSVP form is the only other place a phone is collected,
-- and that one lives on rsvps.phone).
ALTER TABLE households ADD COLUMN phone TEXT;
