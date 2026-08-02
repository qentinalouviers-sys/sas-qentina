
-- 1. Alter status check constraint on bank_transactions
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check CHECK (status IN ('pending_invoice', 'facture_ok', 'reconciled', 'ignored'));

-- 2. Add accounting_class to bank_transactions if not exists
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS accounting_class text;

-- 3. Add accounting_ref to invoices if not exists
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_ref text;

-- 4. Add accounting_class to invoices if not exists
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_class text;
