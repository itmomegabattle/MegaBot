-- Explicit scope instead of inserting a fictitious 'all' faculty into the catalog.
ALTER TABLE tasks ADD COLUMN faculty_all boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD CONSTRAINT tasks_all_faculty_scope CHECK (NOT faculty_all OR faculty_id IS NULL);
