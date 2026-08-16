-- Mailing checklist: when Michael checked this household's stuffed envelope
-- off as sent. NULL = not yet checked. A timestamp (not a flag) so the
-- checklist can show/sort by when it was checked, and unchecking is just
-- setting it back to NULL.
ALTER TABLE households ADD COLUMN mailed_at TEXT;
