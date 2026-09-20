WITH attendu(ordre, migration, objet, present) AS (VALUES
  -- schema.sql (base)
  (0, 'schema.sql', 'table invoices',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'invoices')),
  (0, 'schema.sql', 'table bank_transactions',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bank_transactions')),
  (0, 'schema.sql', 'table square_orders',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'square_orders')),
  (0, 'schema.sql', 'table ingredients / recipes / inventory_counts',
    (SELECT count(*) = 3 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ingredients', 'recipes', 'inventory_counts'))),

  -- migration_consolidee.sql
  (1, 'migration_consolidee.sql', 'invoices : accounting_ref, accounting_class, type_document, company_name_present, tva_recoverable, payment_method, payment_notes',
    (SELECT count(*) = 7 FROM information_schema.columns WHERE table_name = 'invoices'
       AND column_name IN ('accounting_ref', 'accounting_class', 'type_document', 'company_name_present', 'tva_recoverable', 'payment_method', 'payment_notes'))),
  (1, 'migration_consolidee.sql', 'bank_transactions.accounting_class',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bank_transactions' AND column_name = 'accounting_class')),
  (1, 'migration_consolidee.sql', 'bank_transactions : statut facture_ok accepté',
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_status_check' AND pg_get_constraintdef(oid) LIKE '%facture_ok%')),
  (1, 'migration_consolidee.sql', 'bank_transactions : catégories investissement et flux_financier acceptées',
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_category_check'
       AND pg_get_constraintdef(oid) LIKE '%investissement%' AND pg_get_constraintdef(oid) LIKE '%flux_financier%')),
  (1, 'migration_consolidee.sql', 'index anti-doublon idx_bank_transactions_unique',
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_bank_transactions_unique')),
  (1, 'migration_consolidee.sql', 'square_orders.raw_data et square_items.category_name',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'square_orders' AND column_name = 'raw_data')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'square_items' AND column_name = 'category_name')),
  (1, 'migration_consolidee.sql', 'table mouvements_cca (avec invoice_id)',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mouvements_cca' AND column_name = 'invoice_id')),
  (1, 'migration_consolidee.sql', 'table app_settings',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_settings')),

  -- migration_trajets.sql
  (2, 'migration_trajets.sql', 'table mileage_trips (avec cca_movement_id)',
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mileage_trips' AND column_name = 'cca_movement_id')),
  (2, 'migration_trajets.sql', 'index unique idx_mileage_trips_dedupe (non partiel)',
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_mileage_trips_dedupe' AND indexdef NOT ILIKE '% WHERE %')),

  -- migration_ai_settings.sql
  (3, 'migration_ai_settings.sql', 'table ai_settings (clés IA chiffrées)',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_settings')),
  (3, 'migration_ai_settings.sql', 'ai_settings : RLS activé SANS policy (service_role seulement)',
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'ai_settings' AND c.relrowsecurity)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_settings')),

  -- migration_referentiel.sql
  (4, 'migration_referentiel.sql', 'table ingredient_aliases',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ingredient_aliases')),

  -- migration_cca_verrou.sql
  (5, 'migration_cca_verrou.sql', 'fonction cca_verifier_solde',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cca_verifier_solde')),
  (5, 'migration_cca_verrou.sql', 'trigger trg_cca_verrou (compte courant jamais débiteur)',
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cca_verrou' AND NOT tgisinternal)),

  -- migration_clotures.sql
  (6, 'migration_clotures.sql', 'tables closures et closure_log',
    (SELECT count(*) = 2 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('closures', 'closure_log'))),
  (6, 'migration_clotures.sql', 'fonction mois_est_clos',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mois_est_clos')),
  (6, 'migration_clotures.sql', 'trigger trg_cloture sur invoices, invoice_lines, bank_transactions, mouvements_cca, mileage_trips',
    (SELECT count(DISTINCT c.relname) = 5 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'trg_cloture' AND NOT t.tgisinternal
       AND c.relname IN ('invoices', 'invoice_lines', 'bank_transactions', 'mouvements_cca', 'mileage_trips'))),

  -- migration_cca_rapprochement.sql
  (7, 'migration_cca_rapprochement.sql', 'index unique idx_mouvements_cca_bank_tx (un virement porté une seule fois)',
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_mouvements_cca_bank_tx' AND indexdef ILIKE 'CREATE UNIQUE INDEX%')),

  -- migration_agent_api.sql (agents IA)
  (8, 'migration_agent_api.sql', 'table agent_keys (clés d''agent, empreinte SHA-256)',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_keys')),
  (8, 'migration_agent_api.sql', 'agent_keys : colonnes scopes, key_hash, revoked_at, last_used_at',
    (SELECT count(*) = 4 FROM information_schema.columns WHERE table_name = 'agent_keys'
       AND column_name IN ('scopes', 'key_hash', 'revoked_at', 'last_used_at'))),
  (8, 'migration_agent_api.sql', 'table agent_calls (journal des appels)',
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_calls')),
  (8, 'migration_agent_api.sql', 'agent_keys : index idx_agent_keys_hash',
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_agent_keys_hash')),

  -- migration_fiabilite.sql (TVA lue, trace OCR)
  (9, 'migration_fiabilite.sql', 'invoices : tva_amount, tva_breakdown, ocr_meta',
    (SELECT count(*) = 3 FROM information_schema.columns WHERE table_name = 'invoices'
       AND column_name IN ('tva_amount', 'tva_breakdown', 'ocr_meta')))
)
SELECT
  CASE WHEN present THEN '✓ ok' ELSE '✗ MANQUE' END AS etat,
  migration,
  objet
FROM attendu
ORDER BY present, ordre, objet;

-- Resume : les fichiers a executer, dans l'ordre (dernier resultat affiche par l'editeur Supabase).
WITH attendu(ordre, migration, present) AS (VALUES
  (1, 'migration_consolidee.sql',        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'payment_method')
                                          AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_category_check' AND pg_get_constraintdef(oid) LIKE '%flux_financier%')),
  (2, 'migration_trajets.sql',           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mileage_trips' AND column_name = 'cca_movement_id')),
  (3, 'migration_ai_settings.sql',       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_settings')),
  (4, 'migration_referentiel.sql',       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ingredient_aliases')),
  (5, 'migration_cca_verrou.sql',        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cca_verrou')),
  (6, 'migration_clotures.sql',          EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mois_est_clos')
                                          AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_cloture') >= 5),
  (7, 'migration_cca_rapprochement.sql', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_mouvements_cca_bank_tx')),
  (8, 'migration_agent_api.sql',         (SELECT count(*) = 2 FROM information_schema.tables WHERE table_name IN ('agent_keys', 'agent_calls'))),
  (9, 'migration_fiabilite.sql',         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'ocr_meta'))
)
SELECT
  CASE WHEN bool_and(present) THEN 'Rien à exécuter : la base est à jour.'
       ELSE 'À exécuter, dans cet ordre : ' || string_agg('db/' || migration, ' → ' ORDER BY ordre) END AS a_faire
FROM attendu
WHERE NOT present OR NOT EXISTS (SELECT 1 FROM attendu WHERE NOT present);

-- Verification de la base : quelles migrations manquent ?
-- Lecture seule, sans effet. Toutes les migrations sont idempotentes.
-- L'editeur Supabase n'affiche que le resultat de la DERNIERE requete : le resume.
-- Pour le detail objet par objet, executer seulement la premiere requete (jusqu'au premier point-virgule).
-- Ordre si plusieurs manquent : consolidee, trajets, ai_settings, referentiel,
-- cca_verrou, clotures, cca_rapprochement, agent_api, fiabilite.
