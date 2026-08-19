-- Wedding-day photo/video feed. Media bytes live in R2 (bucket
-- mikeandxan-media, binding MEDIA); this table is the feed metadata.
CREATE TABLE feed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'upload', -- 'upload' (site page) | 'sms' (Twilio, later)
  sender_name TEXT,
  sender_phone TEXT,                     -- sms only
  caption TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,     -- admin moderation
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feed_items_created ON feed_items (created_at DESC);
