-- Performance optimization indexes for missing_persons data
-- Run commands in PostgreSQL database to improve query performance
-- Note: missing_persons_parsed is a VIEW, so indexes must be on the base missing_persons table

-- Indexes for the base missing_persons table
-- Index on reported_on for date parsing operations
CREATE INDEX IF NOT EXISTS idx_missing_persons_reported_on
ON missing_persons(reported_on)
WHERE reported_on IS NOT NULL;

-- Indexes for date columns
CREATE INDEX IF NOT EXISTS idx_missing_persons_dates
ON missing_persons(date_last_seen, date_located)
WHERE date_last_seen IS NOT NULL;

-- Indexes for demographic filtering
CREATE INDEX IF NOT EXISTS idx_missing_persons_misstype
ON missing_persons(misstype)
WHERE misstype IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_missing_persons_sex
ON missing_persons(sex)
WHERE sex IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_missing_persons_race
ON missing_persons(race, ethnicity)
WHERE race IS NOT NULL;

-- Indexes for NCIC/ACIC status queries
CREATE INDEX IF NOT EXISTS idx_missing_persons_ncic_acic
ON missing_persons(ncic_entered, ncic_cleared);

-- Note: Since missing_persons_parsed is a view, PostgreSQL will use indexes
-- from the underlying missing_persons table when executing queries against the view.
