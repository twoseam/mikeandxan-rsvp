-- Seating planner: which table each guest sits at. One row per seated
-- guest; no row = not seated yet. Table 0 is the head table (Mike & Xan),
-- 1-18 are the round guest tables on the floor plan.
CREATE TABLE seating (
  guest_id  INTEGER PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
  table_no  INTEGER NOT NULL,
  seated_at TEXT NOT NULL
);
