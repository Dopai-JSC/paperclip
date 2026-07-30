-- Dopai migration range marker (Bước nền).
-- Upstream paperclip migrations own 0000–0499; every Dopai-authored migration
-- lives at 0500 or above so upstream merges never collide with Dopai numbering.
-- This marker must stay the lexicographically last journal entry: when merging
-- upstream migrations 0136–0499, re-sort meta/_journal.json so the 0500 entry
-- remains last, otherwise check-migration-numbering fails.
CREATE TABLE IF NOT EXISTS "dopai_migration_marker" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"note" text NOT NULL DEFAULT 'Dopai migrations start at 0500. Do not add Dopai migrations below 0500.',
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
