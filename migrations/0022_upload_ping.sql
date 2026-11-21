-- Remembers the last upload Michael was emailed about (every-15-min ping).
CREATE TABLE upload_ping (id INTEGER PRIMARY KEY, last_item_id INTEGER NOT NULL);
INSERT INTO upload_ping (id, last_item_id) SELECT 1, COALESCE(MAX(id), 0) FROM feed_items;
