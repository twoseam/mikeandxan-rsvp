-- Web-size copy of each photo (2048px JPEG) for viewing on the site;
-- the original stays as the print-quality download. Sizes feed the
-- "Web size / Full quality" labels on the download sheet.
ALTER TABLE feed_items ADD COLUMN web_key TEXT;
ALTER TABLE feed_items ADD COLUMN bytes INTEGER;
ALTER TABLE feed_items ADD COLUMN web_bytes INTEGER;
