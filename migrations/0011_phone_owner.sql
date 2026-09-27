-- Whose cell households.phone is ("Steve Martin") — Michael picks which
-- household member a number is recorded under. NULL when he just typed
-- a number in without choosing anyone.
ALTER TABLE households ADD COLUMN phone_owner TEXT;
