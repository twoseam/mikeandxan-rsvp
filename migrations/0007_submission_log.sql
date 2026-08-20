-- Black-box recorder for RSVP submissions (Aug 19 2026, after the
-- half-saved Tavernaro RSVP): every submit attempt is written here raw,
-- BEFORE any processing, so no downstream bug can lose a guest's answers.
CREATE TABLE submission_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'received',
  error TEXT
);
