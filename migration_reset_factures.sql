-- ================================================================
-- RESET COMPLET — Factures & Statuts transactions bancaires
-- À exécuter dans Supabase SQL Editor
-- Date : 2026-06-22
-- ================================================================

-- ⚠️  CE SCRIPT EST IRRÉVERSIBLE — Lire avant d'exécuter

-- ── ÉTAPE 1 : Supprimer les lignes de factures ────────────────
DELETE FROM invoice_lines;

-- ── ÉTAPE 2 : Supprimer toutes les factures ───────────────────
DELETE FROM invoices;

-- ── ÉTAPE 3 : Supprimer tous les fournisseurs (optionnel)
-- (Commenter cette ligne si tu veux garder les fournisseurs)
-- DELETE FROM suppliers;

-- ── ÉTAPE 4 : Remettre toutes les transactions bancaires
--             en statut "pending_invoice" (facture manquante)
--             et effacer les liens invoice_id ────────────────
UPDATE bank_transactions
SET
  status     = 'pending_invoice',
  invoice_id = NULL
WHERE status IN ('reconciled', 'facture_ok', 'pending_invoice', 'ignored');

-- ── ÉTAPE 5 : Vérification finale ─────────────────────────────
SELECT 'Factures restantes'      AS check_name, COUNT(*) AS total FROM invoices
UNION ALL
SELECT 'Lignes factures restantes',               COUNT(*) FROM invoice_lines
UNION ALL
SELECT 'Tx en pending_invoice',                   COUNT(*) FROM bank_transactions WHERE status = 'pending_invoice'
UNION ALL
SELECT 'Tx encore reconciled',                    COUNT(*) FROM bank_transactions WHERE status = 'reconciled'
UNION ALL
SELECT 'Tx avec invoice_id encore lié',           COUNT(*) FROM bank_transactions WHERE invoice_id IS NOT NULL;

-- Résultat attendu :
-- Factures restantes            → 0
-- Lignes factures restantes     → 0
-- Tx en pending_invoice         → [toutes tes transactions]
-- Tx encore reconciled          → 0
-- Tx avec invoice_id encore lié → 0
