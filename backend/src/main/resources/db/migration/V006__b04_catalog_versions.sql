ALTER TABLE competencies ADD COLUMN version bigint NOT NULL DEFAULT 0;
ALTER TABLE faculties ADD COLUMN version bigint NOT NULL DEFAULT 0;

CREATE INDEX competencies_active_scope_name_idx ON competencies (active, scope, name);
CREATE INDEX faculties_active_name_idx ON faculties (active, name);
