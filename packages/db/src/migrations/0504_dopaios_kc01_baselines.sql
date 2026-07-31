-- 0504: projection Product Baseline cho spike KC-01 — baseline ghim danh sách
-- artifact theo (id, revision, sha256), không "latest"; nguồn sự thật vẫn là
-- event BaselinePinned trong message_store.messages.
CREATE TABLE IF NOT EXISTS "dopaios_product_baselines" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"items" jsonb NOT NULL,
	"pinned_by" text NOT NULL,
	CONSTRAINT "dopaios_product_baselines_id_revision_pk" PRIMARY KEY ("id", "revision")
);
