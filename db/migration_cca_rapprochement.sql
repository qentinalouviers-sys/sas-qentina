-- ═══════════════════════════════════════════════════════════════════
--  Compte courant d'associé : un virement bancaire = un seul mouvement
--  À exécuter dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Rien n'empêchait jusqu'ici de rattacher DEUX mouvements de compte courant à
-- la même ligne bancaire. Un double clic sur « Valider le remboursement », une
-- relance de page, et le même virement LCL débitait le compte courant deux
-- fois : l'associé se retrouvait à devoir de l'argent qu'il n'a jamais reçu,
-- et le verrou « jamais débiteur » finissait par refuser des opérations
-- parfaitement légitimes.
--
-- L'index ci-dessous rend le doublon impossible. Il est SIMPLE, pas partiel :
-- en PostgreSQL les NULL sont distincts entre eux par défaut, donc tous les
-- mouvements sans lien bancaire (la majorité) cohabitent sans se gêner. C'est
-- aussi la seule forme qu'un futur « ON CONFLICT (bank_transaction_id) »
-- saurait utiliser — un index partiel serait rejeté.

-- ── 1. État des lieux AVANT création ────────────────────────────────
-- Si cette requête renvoie des lignes, l'index ne pourra pas être créé :
-- il faut d'abord supprimer le mouvement en trop depuis la page Comptes
-- Associés (celui qui fait double emploi, pas les deux).
SELECT bank_transaction_id,
       count(*) AS mouvements,
       string_agg(id::text || ' (' || date::text || ', ' || montant::text || ' €)', ' | ') AS detail
FROM mouvements_cca
WHERE bank_transaction_id IS NOT NULL
GROUP BY bank_transaction_id
HAVING count(*) > 1;

-- ── 2. Le drapeau « rapproché » doit dire la vérité ─────────────────
-- Un mouvement rattaché à une ligne bancaire EST rapproché : on aligne le
-- drapeau sur le fait. L'inverse (drapeau levé sans lien) n'est PAS corrigé
-- ici — il peut s'agir d'un rapprochement fait à la main hors outil, et
-- l'effacer perdrait une information. La page Comptes Associés les liste.
UPDATE mouvements_cca
SET rapproche_banque = true
WHERE bank_transaction_id IS NOT NULL
  AND rapproche_banque IS DISTINCT FROM true;

-- ── 3. Le verrou ────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_mouvements_cca_bank_tx
  ON mouvements_cca(bank_transaction_id);

CREATE INDEX IF NOT EXISTS idx_mouvements_cca_associe_date
  ON mouvements_cca(associe, date);

-- ── 4. Vérification ─────────────────────────────────────────────────
SELECT 'index anti-doublon bancaire' AS controle,
  EXISTS (SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_mouvements_cca_bank_tx'
            AND i.indisunique AND i.indpred IS NULL) AS ok
UNION ALL
SELECT 'aucun virement compté deux fois',
  NOT EXISTS (SELECT 1 FROM mouvements_cca
              WHERE bank_transaction_id IS NOT NULL
              GROUP BY bank_transaction_id HAVING count(*) > 1)
UNION ALL
SELECT 'drapeau « rapproché » cohérent avec le lien',
  NOT EXISTS (SELECT 1 FROM mouvements_cca
              WHERE bank_transaction_id IS NOT NULL AND rapproche_banque IS DISTINCT FROM true);

-- ── 5. Le solde de chaque associé, à confronter à l'écran ───────────
SELECT associe,
       round(sum(CASE WHEN sens = 'apport' THEN montant ELSE -montant END), 2) AS solde,
       count(*) FILTER (WHERE sens = 'apport') AS apports,
       count(*) FILTER (WHERE sens = 'remboursement') AS remboursements,
       count(*) FILTER (WHERE sens = 'remboursement' AND bank_transaction_id IS NULL)
         AS remboursements_sans_ligne_bancaire
FROM mouvements_cca
GROUP BY associe;
