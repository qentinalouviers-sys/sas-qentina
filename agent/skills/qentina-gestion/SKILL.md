---
name: qentina-gestion
description: Piloter la gestion et la pré-comptabilité du restaurant QENTINA — santé comptable, chiffres du mois, ventes, P&L, TVA, factures (lecture OCR et enregistrement), lettrage bancaire, comptes courants d'associés, frais kilométriques, mercuriale, recettes, inventaire. À charger dès qu'une question porte sur la comptabilité, la trésorerie, la TVA, les achats, les ventes ou les notes de frais de QENTINA.
version: 1.1.0
license: MIT
metadata:
  hermes:
    tags: [Business, Accounting, Restaurant, France, MCP]
    requires_tools: [mcp_qentina_get_business_health]
required_environment_variables:
  - name: QENTINA_URL
    prompt: "URL de l'application QENTINA (sans barre oblique finale)"
    help: "Par exemple https://qentina.vercel.app"
    required_for: "Joindre le serveur MCP"
  - name: QENTINA_AGENT_KEY
    prompt: "Clé d'agent QENTINA (qk_live_…)"
    help: "Se crée dans l'application : Réglages → Agents IA. Elle n'est affichée qu'une fois."
    required_for: "Authentification auprès du serveur MCP"
---

# QENTINA — gestion d'un restaurant (TEKOTEK SAS)

Outils de gestion d'une pizzeria au feu de bois à Louviers, exploitée en SAS.
Les données sont réelles et servent à une comptabilité française : chaque
réponse doit être exacte ou explicitement incertaine, jamais approximative.

## Quand l'utiliser

Dès qu'une demande porte sur : l'état de santé du restaurant, le chiffre
d'affaires et les ventes, le coût matières, le compte de résultat, la TVA, les
factures fournisseurs (lecture, enregistrement, lettrage), le relevé bancaire,
les comptes courants d'associés, les frais kilométriques, la mercuriale, le
coût des recettes, l'inventaire, ou la clôture d'un mois.

## Branchement

Serveur MCP HTTP (JSON-RPC, sans flux SSE), à déclarer une fois :

```bash
hermes mcp add qentina --url "$QENTINA_URL/api/agent/mcp" --auth header
hermes mcp test qentina
```

Ou dans `~/.hermes/config.yaml` :

```yaml
mcp_servers:
  qentina:
    url: "${env:QENTINA_URL}/api/agent/mcp"
    headers:
      Authorization: "Bearer ${env:QENTINA_AGENT_KEY}"
    # « untrusted » soumet à approbation tout outil non annoncé en lecture
    # seule. Les outils d'écriture de QENTINA touchent à une comptabilité :
    # c'est le réglage recommandé, y compris pour son propre serveur.
    trust: untrusted
    timeout: 120
```

Le secret va dans `~/.hermes/.env` (`QENTINA_AGENT_KEY=qk_live_…`), jamais dans
`config.yaml`. La clé se crée dans l'application, Réglages → Agents IA, et
n'est affichée qu'une seule fois. Une clé **lecture seule** ne voit pas les
outils d'écriture ; il en faut une avec la portée « write » pour enregistrer.

Le serveur expose aussi la ressource `qentina://guide` (ce document, côté
serveur) et quatre prompts prêts à l'emploi : `bilan_du_mois`, `preparer_tva`,
`traiter_facture`, `lettrage_banque`.

## Outils

### Santé et chiffres (lecture)

| Outil | Ce qu'il donne |
|---|---|
| `get_business_health` | Tout ce qui rend un chiffre faux ou coûte de l'argent, par gravité — **à appeler en premier** |
| `get_monthly_summary` | CA HT/TTC, commandes, achats, coût matières (mesuré ou estimé), TVA d'un mois |
| `get_sales_report` | Ventes Square : par jour, par jour de semaine, ticket moyen, top articles, catégories |
| `get_pnl_breakdown` | Compte de résultat par poste : achats par catégorie, charges, salaires, investissements, flux écartés |
| `get_vat_report` | TVA collectée par taux, déductible (lue sur les factures), solde net, non ventilé |
| `get_closure_status` | Un mois est-il clôturé, peut-il l'être, qu'est-ce qui bloque |

### Pièces et flux (lecture)

| Outil | Ce qu'il donne |
|---|---|
| `list_invoices` / `get_invoice` | Factures (filtres : fournisseur, numéro, période, lettrée ou non) et leurs lignes, TVA lue, pièce, trace OCR |
| `list_bank_transactions` | Écritures bancaires, filtrables (statut, sens, libellé, période) |
| `get_partner_accounts` / `list_partner_movements` | Soldes des comptes courants + rapprochement des virements ; détail chronologique avec solde courant |
| `get_mileage_report` | Frais kilométriques d'une année + couverture des justificatifs |
| `get_ingredient_prices` | La mercuriale : dernier prix d'achat de chaque ingrédient |
| `get_recipe_costs` | Coût matière par recette, prix de vente, food cost %, marge |
| `search_suppliers` | Lever une ambiguïté sur un nom de fournisseur |
| `get_business_rules` | Ce guide, côté serveur |

### Pré-comptabilité (écriture — clé « write »)

| Outil | Ce qu'il fait |
|---|---|
| `analyze_invoice_document` | **(lecture, coûteux)** lit une facture (PDF/image base64) : double lecture OCR, anomalies, doublon, candidats bancaires. Jamais en boucle |
| `register_invoice` | enregistre la facture analysée (corrigée), avec acquittement des anomalies par code, lettrage, compte courant si payée en perso |
| `link_invoice_to_bank_transaction` | lettre une facture existante avec son paiement (montant au centime, `force` pour un partiel) |
| `update_bank_transaction` | corrige la catégorie, le statut ou la classe d'un mouvement bancaire |
| `record_inventory_count` | enregistre le comptage d'un ingrédient (inventaire) |
| `record_missing_mileage_trips` | enregistre les trajets attestés manquants |
| `link_bank_transfer_to_partner_account` | porte un virement au compte courant d'un associé |

Conventions : montants en euros, dates `AAAA-MM-JJ`, mois `AAAA-MM`. Chaque
réponse contient une phrase de synthèse en français — **cite-la plutôt que de
recalculer**. Les listes sont bornées et annoncent `truncated`. Un champ `next`
suggère la suite.

## Méthode

1. **Commence par `get_business_health`.** Il dit ce qui ne va pas avant que
   tu ne lises un chiffre qui pourrait être faux. Un point « critique » ouvert
   signifie qu'un chiffre de base est erroné : signale-le avant de répondre.
2. **Un chiffre du mois** → `get_monthly_summary` (synthèse) ou
   `get_pnl_breakdown` (par poste). Le coût matières est **mesuré** (inventaire)
   ou seulement **estimé** sur les achats : ne présente jamais un coût estimé
   comme mesuré.
3. **Avant toute écriture**, appelle l'outil avec `dry_run: true`, montre à
   l'utilisateur ce qui serait créé, puis rejoue sans `dry_run`. Les écritures
   sont idempotentes : rejouer un appel ne duplique rien.
4. **Ne clôture jamais un mois.** `get_closure_status` dit si c'est possible ;
   la clôture elle-même est un geste humain, elle n'est pas exposée.

## Traiter une facture

1. `analyze_invoice_document` avec le fichier. Il lit deux fois (moteur
   principal + contrôle) et rend `extracted`, `anomalies`, `file_url`,
   `bank_candidates`.
2. Relis `extracted` contre le document ; corrige les champs faux (HT, TVA,
   TTC, date, numéro, fournisseur, lignes) dans l'objet.
3. Chaque anomalie `a_confirmer` se vérifie sur le document puis s'acquitte
   par son code dans `confirmations`. Un `bloquant` se lève en corrigeant.
   Une `info` n'appelle rien.
4. `register_invoice` avec `dry_run: true` : le serveur recompte tout. Puis
   sans `dry_run`, avec `file_url`, et `bank_transaction_id` si un candidat
   correspond au centime ; `payment_method` `card_perso`/`cash` + `associe`
   si un associé a payé de sa poche.
5. Ne registre jamais une facture dont un point te paraît faux « pour
   avancer » : une facture fausse contamine la TVA, le coût matières et le
   lettrage.

## Règles métier à connaître

- **Le compte courant d'associé ne peut jamais être débiteur.** C'est interdit
  au dirigeant (art. L.225-43 du code de commerce) et qualifiable d'abus de
  biens sociaux. La base refuse l'écriture ; l'outil renvoie le jour et le
  montant du creux. Ne cherche pas à contourner : propose l'apport qui couvre.
- **Un mois clôturé est en lecture seule.** Toute écriture datée de ce mois est
  refusée. La réouverture est un geste humain, motivé et journalisé.
- **La TVA déductible ne vient que des factures** (art. 271 CGI). Un reçu CB ou
  un bon de livraison n'ouvre pas droit à déduction.
- **La banque date le paiement, la facture date l'achat.** Sur une note de
  frais, c'est le jour du passage en magasin qui compte.
- **Le barème kilométrique est progressif par tranche annuelle** : ajouter un
  trajet change le taux de tous les autres. Ne calcule jamais un trajet isolé.
- **Un virement sortant vers un associé doit être porté au compte courant**,
  sinon le solde affiché est surévalué.

## Pièges

- Une **TVA collectée non ventilée** (`nonVentile` > 0) n'est pas déclarable en
  l'état : dis-le, ne la répartis pas au hasard.
- Le HT des dépenses bancaires sans facture est **indicatif** (taux supposé par
  catégorie) : il sert aux ratios, jamais à une déclaration.
- `get_partner_accounts` peut signaler des **virements non rapprochés** : tant
  qu'ils le sont, les soldes qu'il renvoie sont surévalués.
- Une liste `truncated` n'est pas un total : resserre la période ou augmente
  `limit` avant de sommer quoi que ce soit.
- Un refus d'écriture (`month_closed`, `cca_debtor`, `already_linked`,
  `amount_mismatch`, `invoice_refused`) est une **règle**, pas une panne :
  rapporte-la, ne réessaie pas à l'identique.

## Diagnostic

- `401 invalid_key` → la clé est fausse ou révoquée ; en créer une dans
  Réglages → Agents IA.
- `403 insufficient_scope` → la clé est en lecture seule et l'outil écrit.
- `hermes mcp test qentina` échoue sur le type de contenu → ajouter
  `skip_preflight: true` à l'entrée du serveur.
- Le journal de tous les appels est visible dans Réglages → Agents IA.
