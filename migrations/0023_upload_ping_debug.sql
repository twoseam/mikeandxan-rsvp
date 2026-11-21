-- Debug info for the upload ping.
ALTER TABLE upload_ping ADD COLUMN last_run TEXT;
ALTER TABLE upload_ping ADD COLUMN last_error TEXT;
