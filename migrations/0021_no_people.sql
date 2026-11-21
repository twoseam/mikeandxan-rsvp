-- Lets Michael mark a photo as having no people in it, so it leaves the
-- Faces page's "Not tagged" list.
ALTER TABLE feed_items ADD COLUMN no_people INTEGER NOT NULL DEFAULT 0;
