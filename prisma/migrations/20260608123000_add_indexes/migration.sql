-- prisma/migrations/20260608123000_add_indexes/migration.sql
-- Adds trigram indexes for substring searches and composite indexes for payments

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_lower_name_trgm ON persons USING gin (LOWER(name) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flats_lower_flatnumber_trgm ON flats USING gin (LOWER("flatNumber") gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maintenance_billing_status ON maintenance_payments ("billingMonth", status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maintenance_flatId ON maintenance_payments ("flatId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flats_blockId ON flats ("blockId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_altPhone ON persons ("altPhone");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_paymenttransactions_status_createdAt ON payment_transactions (status, "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fundledger_entryDate ON fund_ledger ("entryDate");
