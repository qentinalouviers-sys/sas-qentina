-- Alter invoices table to add VAT recoverability tracking columns
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS type_document text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_name_present boolean DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tva_recoverable boolean DEFAULT true;
