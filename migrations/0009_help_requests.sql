-- Guests who strike out on the name search can leave their name + contact
-- info instead of silently giving up (the Larry & Sheri Beaty problem).
CREATE TABLE help_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  note TEXT
);
