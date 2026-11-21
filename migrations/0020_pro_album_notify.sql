-- Albums become two: Guest Photos (incl. Michael's Fujifilm shots) and
-- Professional Photos (Juliana Jumper's, coming later).
UPDATE feed_items SET album_id = 1 WHERE album_id = 2;
DELETE FROM albums WHERE id = 2;
UPDATE albums SET name = 'Professional Photos' WHERE id = 3;

-- "Notify me when the professional photos are ready" sign-ups.
CREATE TABLE photo_notify (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  notified_at TEXT
);
