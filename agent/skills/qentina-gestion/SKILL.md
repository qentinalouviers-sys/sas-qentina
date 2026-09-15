---
name: qentina-gestion
description: Piloter la gestion du restaurant QENTINA — santé comptable, chiffres du mois, TVA, factures, banque, comptes courants d'associés et frais kilométriques. À charger dès qu'une question porte sur la comptabilité, la trésorerie, la TVA, les achats ou les notes de frais de QENTINA.
version: 1.0.0
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
d'affaires, le coût matières, la TVA, les factures fournisseurs, le relevé
bancaire, les comptes courants d'associés, les frais kilométriques, ou la
clôture d'un mois.

## Branchement

Serveur MCP HTTP, à déclarer une fois :

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
n'est affichée qu'une seule fois.

## Outils

| Outil | Ce qu'il donne |
|---|---|
| `get_business_health` | Tout ce qui rend un chiffre faux ou coûte de l'argent, par gravité |
| `get_monthly_summary` | CA HT/TTC, commandes, achats, coût matières, TVA d'un mois |
| `get_vat_report` | TVA collectée par taux, déductible, solde net |
| `list_invoices` / `get_invoice` | Factures fournisseurs et leurs lignes |
| `list_bank_transactions` | Écritures bancaires, filtrables |
| `get_partner_accounts` | Soldes des comptes courants + rapprochement des virements |
| `get_mileage_report` | Frais kilométriques d'une année + couverture des justificatifs |
| `get_closure_status` | Un mois est-il clôturé, peut-il l'être, qu'est-ce qui bloque |
| `search_suppliers` | Lever une ambiguïté sur un nom de fournisseur |
| `record_missing_mileage_trips` | **(écriture)** enregistre les trajets attestés manquants |
| `link_bank_transfer_to_partner_account` | **(écriture)** porte un virement au compte courant |

Conventions : montants en euros, dates `AAAA-MM-JJ`, mois `AAAA-MM`. Chaque
réponse contient une phrase de synthèse en français — **cite-la plutôt que de
recalculer**. Les listes sont bornées et annoncent `truncated`.

## Méthode

1. **Commence par `get_business_health`.** Il dit ce qui ne va pas avant que
   tu ne lises un chiffre qui pourrait être faux. Un point « critique » ouvert
   signifie qu'un chiffre de base est erroné : signale-le avant de répondre.
2. **Un chiffre du mois** → `get_monthly_summary`. Il précise si le coût
   matières est **mesuré** (inventaire) ou seulement **estimé** sur les achats.
   Ne présente jamais un coût matières estimé comme mesuré.
3. **Avant toute écriture**, appelle l'outil avec `dry_run: true` et montre à
   l'utilisateur ce qui serait créé. Les écritures sont idempotentes : rejouer
   un appel ne duplique rien.
4. **Ne clôture jamais un mois.** `get_closure_status` dit si c'est possible ;
   la clôture elle-même est un geste humain, elle n'est pas exposée.

## Règles métier à connaître

- **Le compte courant d'associé ne peut jamais être débiteur.** C'est interdit
  au dirigeant (art. L.225-43 du code de commerce) et qualifiable d'abus de
  biens sociaux. La base refuse l'écriture ; l'outil renvoie le jour et le
  montant du creux. Ne cherche pas à contourner : propose l'apport qui couvre.
- **Un mois clôturé est en lecture seule.** Toute écriture datée de ce mois est
  refusée. La réouverture est un geste humain, motivé et journalisé.
- **La banque date le paiement, la facture date l'achat.** Sur une note de
  frais, c'est le jour du passage en magasin qui compte.
- **Le barème kilométrique est progressif par tranche annuelle** : ajouter un
  trajet change le taux de tous les autres. Ne calcule jamais un trajet isolé.
- **Un virement sortant vers un associé doit être porté au compte courant**,
  sinon le solde affiché est surévalué et la société paraît devoir ce qu'elle
  a déjà versé.

## Pièges

- Une **TVA collectée non ventilée** (`nonVentile` > 0) n'est pas déclarable en
  l'état : dis-le, ne la répartis pas au hasard.
- `get_partner_accounts` peut signaler des **virements non rapprochés** : tant
  qu'ils le sont, les soldes qu'il renvoie sont surévalués. Mentionne-le avec
  le solde, pas après.
- Une liste `truncated` n'est pas un total : resserre la période ou augmente
  `limit` avant de sommer quoi que ce soit.
- Un refus d'écriture (`month_closed`, `cca_debtor`, `already_linked`) est une
  **règle**, pas une panne : rapporte-la, ne réessaie pas.

## Diagnostic

- `401 invalid_key` → la clé est fausse ou révoquée ; en créer une dans
  Réglages → Agents IA.
- `403 insufficient_scope` → la clé est en lecture seule et l'outil écrit.
- `hermes mcp test qentina` échoue sur le type de contenu → ajouter
  `skip_preflight: true` à l'entrée du serveur.
