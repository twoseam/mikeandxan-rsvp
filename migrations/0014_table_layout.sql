-- Seating planner: where each table sits on the floor plan, once Michael
-- drags it somewhere new. No row = the table's spot from his diagram.
CREATE TABLE seat_tables (
  table_no INTEGER PRIMARY KEY,
  x        REAL NOT NULL,
  y        REAL NOT NULL
);
