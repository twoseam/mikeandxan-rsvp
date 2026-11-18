-- Face tagging for the photo site.
-- Faces are found by a helper running on Michael's Mac Studio (open-source
-- Human library in a local Chrome). Each face's "fingerprint" (embedding)
-- is stored here so new faces can be matched to people already labeled.
-- Plan: delete embeddings once tagging is finished (see faceClearEmbeddings).

-- A person who can be tagged. Usually linked to a guest-list row; can also
-- be a free-typed name. ignored = 1 is a bucket for faces Michael chose to
-- ignore (staff, strangers) — never shown to guests.
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  ignored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_people_guest ON people(guest_id);

-- One detected face in one feed item (photo or video).
-- status: 'new'       — not tagged yet (may carry a suggestion to ask about)
--         'auto'      — tagged automatically (match cleared the auto line)
--         'confirmed' — tagged by Michael
-- rejected: comma-separated person ids Michael said "no" to for this face.
CREATE TABLE faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  box TEXT NOT NULL,              -- JSON [x, y, w, h] as 0..1 fractions of the frame
  size INTEGER NOT NULL DEFAULT 0, -- face size in px (bigger = clearer)
  thumb_key TEXT,                 -- R2 key of the small face crop
  embedding TEXT,                 -- base64 Float32 fingerprint; NULL once cleared
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new',
  suggest_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  suggest_sim REAL,
  rejected TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_faces_item ON faces(item_id);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_faces_status ON faces(status);

-- Manual tags: "this person is in this photo" when no face was found
-- (back of head, too small, etc).
CREATE TABLE photo_tags (
  item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, person_id)
);

-- When the helper finished scanning an item (NULL = waiting). faces_error
-- records a file the helper couldn't open, so it isn't retried forever.
ALTER TABLE feed_items ADD COLUMN faces_scanned_at TEXT;
ALTER TABLE feed_items ADD COLUMN faces_error TEXT;

-- Single-row status of the Mac Studio helper, for the admin page.
CREATE TABLE face_helper (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen TEXT,
  info TEXT
);
INSERT INTO face_helper (id, last_seen, info) VALUES (1, NULL, NULL);
