/**
 * guide.ts — Les règles métier et la méthode, telles qu'un agent doit les lire.
 *
 * Un seul texte, servi trois fois : dans `instructions` à l'initialisation MCP
 * (version courte), comme ressource MCP `qentina://guide`, et par l'outil
 * `get_business_rules` pour les clients qui ne lisent pas les ressources.
 * C'est la même matière que `agent/skills/qentina-gestion/SKILL.md`, gardée
 * ici pour qu'un agent branché sans le skill ne soit pas moins bien informé.
 */

export const GUIDE_SHORT =
  "QENTINA — gestion et comptabilité d'une pizzeria (TEKOTEK SAS, France). "
  + 'Méthode : commence par get_business_health (ce qui rend un chiffre faux), puis get_monthly_summary '
  + 'ou get_pnl_breakdown pour les chiffres, get_vat_report pour la TVA. Chaque réponse porte une phrase '
  + 'de synthèse en français : cite-la plutôt que de recalculer. Montants en euros, dates AAAA-MM-JJ, '
  + 'mois AAAA-MM. Avant toute écriture, appelle l\'outil avec dry_run: true et montre le résultat. '
  + 'Les refus (month_closed, cca_debtor, already_linked, amount_mismatch) sont des règles, pas des '
  + 'pannes : rapporte-les, ne réessaie pas à l\'identique. Lis la ressource qentina://guide (ou '
  + 'l\'outil get_business_rules) pour les règles complètes.';

export const GUIDE_MARKDOWN = `# QENTINA — guide de l'agent

Outils de gestion d'une pizzeria au feu de bois à Louviers, exploitée en SAS
(TEKOTEK). Les données sont réelles et servent à une comptabilité française :
chaque réponse doit être exacte ou explicitement incertaine, jamais approximative.

## Conventions

- Montants en euros (nombres décimaux), dates \`AAAA-MM-JJ\`, mois \`AAAA-MM\`.
- Chaque résultat porte une phrase de synthèse en français : **cite-la** plutôt
  que de recalculer. Le détail est dans \`data\`.
- Les listes sont bornées et annoncent \`truncated\` : une liste tronquée n'est
  pas un total. Resserre la période ou augmente \`limit\` avant de sommer.
- Un champ \`next\` suggère les outils qui prolongent naturellement la réponse.

## Méthode

1. **Commence par \`get_business_health\`.** Il dit ce qui ne va pas avant que
   tu ne lises un chiffre qui pourrait être faux. Un point « critique » ouvert
   signifie qu'un chiffre de base est erroné : signale-le avant de répondre.
2. **Un chiffre du mois** → \`get_monthly_summary\` (synthèse) ou
   \`get_pnl_breakdown\` (par poste). Le coût matières est **mesuré** (inventaire)
   ou seulement **estimé** sur les achats : ne présente jamais un coût estimé
   comme mesuré.
3. **Les ventes** → \`get_sales_report\` (par jour, par jour de semaine, top
   articles, catégories). Le chiffre d'affaires vient de la caisse Square,
   jamais des encaissements bancaires.
4. **La TVA** → \`get_vat_report\`. La TVA déductible ne vient que des factures
   (art. 271 CGI). Une TVA collectée \`nonVentile\` n'est pas déclarable en
   l'état : dis-le, ne la répartis pas.
5. **Avant toute écriture**, appelle l'outil avec \`dry_run: true\`, montre à
   l'utilisateur ce qui serait créé, puis rejoue sans \`dry_run\`. Les écritures
   sont idempotentes : rejouer un appel ne duplique rien.
6. **Ne clôture jamais un mois.** \`get_closure_status\` dit si c'est possible ;
   la clôture est un geste humain, elle n'est pas exposée.

## Traiter une facture (pré-comptabilité)

1. \`analyze_invoice_document\` avec le fichier (PDF ou image en base64). Il lit
   la facture deux fois (moteur principal + contrôle), signale les champs
   incertains, les totaux incohérents, un doublon probable, et propose les
   mouvements bancaires candidats. **Coûteux** : un appel par document, jamais
   en boucle.
2. Relis \`extracted\` contre ce que tu sais du document. Corrige les champs
   faux dans l'objet (HT, TVA, TTC, date, numéro, fournisseur, lignes).
3. Chaque anomalie \`a_confirmer\` doit être vérifiée puis acquittée par son
   code dans \`confirmations\`. Un \`bloquant\` se lève en corrigeant le champ.
   Une \`info\` n'appelle rien.
4. \`register_invoice\` avec \`dry_run: true\` : le serveur recompte tout et
   dit ce qui manque. Puis sans \`dry_run\`. Passe \`bank_transaction_id\` si un
   candidat bancaire correspond au centime, \`payment_method\` \`card_perso\` ou
   \`cash\` avec \`associe\` si un associé a payé de sa poche (un mouvement de
   compte courant est créé).
5. Ne registre jamais une facture dont un point te paraît faux « pour avancer » :
   une facture fausse en base contamine la TVA, le coût matières et le lettrage.

## Lettrer et classer la banque

- \`list_bank_transactions\` avec \`status: pending_invoice\` liste les dépenses
  sans facture. \`list_invoices\` avec \`bank_link: unlinked\` liste les factures
  sans paiement. \`link_invoice_to_bank_transaction\` les relie : montant égal
  au centime, sinon \`force: true\` en le justifiant (paiement partiel ou groupé).
- \`update_bank_transaction\` corrige la catégorie d'un mouvement (le P&L, la
  TVA et le tableau de bord suivent) ou son statut (\`ignored\` pour un mouvement
  hors gestion). Un mouvement lettré ne se recatégorise pas : délie d'abord.

## Règles métier à connaître

- **Le compte courant d'associé ne peut jamais être débiteur.** C'est interdit
  au dirigeant (art. L.225-43 du code de commerce). La base refuse l'écriture ;
  l'outil renvoie le jour et le montant du creux. Ne contourne pas : propose
  l'apport qui couvre.
- **Un mois clôturé est en lecture seule.** Toute écriture datée de ce mois est
  refusée (\`month_closed\`). La réouverture est un geste humain, motivé et
  journalisé.
- **La banque date le paiement, la facture date l'achat.** Sur une note de
  frais, c'est le jour du passage en magasin qui compte.
- **Le barème kilométrique est progressif par tranche annuelle** : ajouter un
  trajet change le taux de tous les autres. Ne calcule jamais un trajet isolé.
- **Un virement sortant vers un associé doit être porté au compte courant**,
  sinon le solde affiché est surévalué.
- **Un reçu CB ou un bon de livraison n'ouvre pas droit à déduction** : seule
  une facture au nom de la société (ou un ticket ≤ 150 € HT) le fait.

## Pièges

- \`get_partner_accounts\` peut signaler des virements non rapprochés : tant
  qu'ils le sont, les soldes sont surévalués. Mentionne-le avec le solde.
- Le HT des dépenses bancaires sans facture est **indicatif** (taux supposé par
  catégorie) : il sert aux ratios, jamais à une déclaration.
- Un refus d'écriture (\`month_closed\`, \`cca_debtor\`, \`already_linked\`,
  \`amount_mismatch\`, \`invalid_arguments\`) est une **règle** ou une consigne :
  lis le message, corrige, ne réessaie pas à l'identique.
- \`analyze_invoice_document\` et \`register_invoice\` déposent la pièce
  justificative dans le stockage : passe toujours \`file_url\` de l'analyse à
  l'enregistrement.
`;
