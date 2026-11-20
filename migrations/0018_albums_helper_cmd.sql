-- Albums for the photo feed. Everything before this lands in "Guest Photos";
-- guest uploads keep going there. Michael uploads to the others from the
-- photo page (admin only).
CREATE TABLE albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  guest_uploads INTEGER NOT NULL DEFAULT 0,  -- 1 = where guests' uploads go
  created_at TEXT NOT NULL
);
INSERT INTO albums (id, name, sort, guest_uploads, created_at) VALUES
  (1, 'Guest Photos', 1, 1, '2026-11-20T00:00:00Z'),
  (2, 'Fujifilm', 2, 0, '2026-11-20T00:00:00Z'),
  (3, 'Juliana Jumper', 3, 0, '2026-11-20T00:00:00Z');

ALTER TABLE feed_items ADD COLUMN album_id INTEGER NOT NULL DEFAULT 1 REFERENCES albums(id);
-- Anything uploaded as "photographer" so far belongs to the photographer's album.
UPDATE feed_items SET album_id = 3 WHERE source = 'pro';

-- One-shot instruction for the Mac Studio scanner ('restart' | 'update').
ALTER TABLE face_helper ADD COLUMN command TEXT;
