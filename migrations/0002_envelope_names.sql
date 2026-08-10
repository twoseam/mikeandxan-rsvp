-- Envelope printing: the name printed on the recipient's envelope isn't a
-- mechanical join of guests.name ("The Martin Family" instead of "Daniel
-- Martin, Aly Martin, ..."; "Alyson" instead of the nickname "Aly" used
-- everywhere else) - it's curated per household, so it needs its own field
-- rather than being derived at render time.
ALTER TABLE households ADD COLUMN envelope_name TEXT;
ALTER TABLE households ADD COLUMN envelope_subline TEXT;
