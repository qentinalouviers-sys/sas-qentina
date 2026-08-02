-- =============================================
-- Migration : Anti-doublons bancaires (protection DB niveau)
-- À exécuter dans Supabase SQL Editor
-- =============================================

-- 1. Supprimer les doublons existants en ne gardant que le plus ancien de chaque groupe
-- (identifié par date + description normalisée + amount)
DELETE FROM bank_transactions
WHERE id NOT IN (
  SELECT DISTINCT ON (
    date,
    -- Normalisation : trim + réduction espaces multiples + lower case
    lower(trim(regexp_replace(description, '\s+', ' ', 'g'))),
    amount
  ) id
  FROM bank_transactions
  ORDER BY
    date,
    lower(trim(regexp_replace(description, '\s+', ' ', 'g'))),
    amount,
    created_at ASC  -- Garder le plus ancien en cas de doublon
);

-- 2. Ajouter une colonne de description normalisée pour l'index (optionnel mais robuste)
-- On ne touche pas à la colonne description existante.
-- On crée un index unique fonctionnel sur la version normalisée :
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_unique
ON bank_transactions (
  date,
  lower(trim(regexp_replace(description, '\s+', ' ', 'g'))),
  amount
);

-- 3. Vérification : compte des lignes restantes après nettoyage
SELECT count(*) AS total_after_cleanup FROM bank_transactions;
