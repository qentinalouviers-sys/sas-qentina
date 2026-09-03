# 🍕 QENTINA — Pilotage de pizzeria

Outil de pilotage et de comptabilité pour pizzeria napolitaine : ventes Square, scanner
de factures par IA, banque, TVA, P&L, comptes d'associés, frais kilométriques, inventaire,
fiches techniques et assistant IA « Fuego ».

Il n'affiche que ce qu'il sait mesurer. Un chiffre qui ne peut pas être juste n'est
pas affiché ; une donnée qui entre en base sans qu'un humain l'ait relue n'entre pas.

> 📋 **Nouveau ici ?** Lis [`AUDIT.md`](./AUDIT.md) : il explique l'architecture, les choix
> et tout ce qui a été corrigé lors de la grande révision d'août 2026.

## Stack

- **Next.js 16** (App Router, `proxy.ts` pour l'auth) + React 19 + TypeScript strict
- **Supabase** : base Postgres + Auth + Storage (fichiers de factures)
- **Square** : source des ventes et **référence du chiffre d'affaires** (synchro nocturne automatique + webhook temps réel)
- **Google Gemini** : OCR des factures (le poste IA le plus coûteux, au tarif le plus bas)
- **Anthropic Claude** : catégorisation bancaire, audits, chat Fuego

## Démarrage

```bash
npm install
cp .env.example .env.local   # puis remplis les variables (voir ci-dessous)
npm run dev
```

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL du projet Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clé publique Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé serveur Supabase (jamais côté client) |
| `ANTHROPIC_API_KEY` | Clé API Claude (banque, Fuego, audits, chat) |
| `SETTINGS_ENCRYPTION_KEY` | Chiffre les clés API saisies dans Réglages → Moteurs IA. `openssl rand -hex 32`, une fois pour toutes |
| `GEMINI_API_KEY` | Clé API Google Gemini — moteur d'OCR des factures ([AI Studio](https://aistudio.google.com/apikey)) |
| `OCR_PROVIDER` | `gemini` ou `anthropic`. Vide = Gemini si sa clé existe, sinon Claude |
| `GEMINI_MODEL` | Modèle Gemini. Vide = `gemini-2.5-flash` |
| `GEMINI_THINKING_BUDGET` | Budget de raisonnement Gemini. `0` par défaut (économie) |
| `SQUARE_ACCESS_TOKEN` | Jeton d'accès Square |
| `SQUARE_LOCATION_ID` | Identifiant du point de vente Square |
| `SQUARE_WEBHOOK_SECRET` | **Important** : secret de signature du webhook (Square Developer Dashboard) |
| `NEXT_PUBLIC_APP_URL` | URL publique de l'app (ex. `https://…vercel.app`) |
| `CRON_SECRET` | **Obligatoire** : authentifie la synchro Square nocturne. Absente, elle refuse de tourner |

### Moteur d'OCR des factures

Le scanner de factures tourne sur **Gemini** (Google), sensiblement moins cher que
Claude à qualité comparable sur de l'extraction structurée. Claude reste en place
pour tout le reste : catégorisation bancaire, Fuego, audits, chat.

Trois choses à savoir :

1. **La bascule est une variable, pas un déploiement.** `OCR_PROVIDER=anthropic`
   ramène le scanner sur Claude sans toucher au code — utile si Gemini se révèle
   moins fiable sur un fournisseur donné.
2. **Le raisonnement est coupé** (`GEMINI_THINKING_BUDGET=0`). Les modèles 2.5
   « réfléchissent » par défaut et facturent ces tokens comme de la sortie : lire
   une facture n'en a aucun besoin. C'est là que se fait l'essentiel de l'économie.
3. **Le prompt est strictement identique** dans les deux moteurs
   (`INVOICE_OCR_PROMPT`, un seul exemplaire). Une différence de résultat vient
   donc du modèle, jamais de la consigne.

Le moteur réellement utilisé est visible à trois endroits : la pastille d'état en
haut de l'application, le champ `ocr_engine` renvoyé par `/api/scanner`, et
`config.ocr_provider` dans `/api/scanner/health`.

Gemini accepte en plus le **HEIC/HEIF** des iPhone, que Claude refusait : les
photos prises sans changer les réglages de l'appareil passent désormais.

### Clés IA : écran Réglages ou variables Vercel

Les clés Anthropic et Google se saisissent dans **Réglages → Moteurs IA**, ce qui
évite un redéploiement à chaque rotation. Le même écran choisit le moteur d'OCR et
le modèle Gemini.

Comment c'est résolu, dans l'ordre : **la base d'abord, les variables
d'environnement ensuite**. Une clé saisie à l'écran s'applique donc tout de suite ;
les variables Vercel restent en repli pour ne jamais se retrouver enfermé
dehors — base indisponible, table vidée par erreur, ou tout premier démarrage.

Trois points de sécurité, qui expliquent la forme du code :

- Les clés vivent dans la table **`ai_settings`**, et pas dans `app_settings` :
  cette dernière est ouverte en lecture et en écriture à tout compte
  authentifié (la page Réglages y écrit depuis le navigateur). `ai_settings`
  n'a **aucune policy** — RLS activé sans policy signifie que personne n'y
  accède, sauf la clé `service_role`, qui ne vit que côté serveur.
- Les valeurs sont **chiffrées en AES-256-GCM** avec `SETTINGS_ENCRYPTION_KEY`.
  Le RLS protège l'accès, le chiffrement protège le contenu si la base fuite :
  ce sont deux portes différentes. Changer cette variable rend illisibles les
  clés déjà enregistrées — l'application le signale et retombe sur les
  variables d'environnement au lieu de tomber en panne.
- Une clé enregistrée **ne ressort jamais**. L'API ne renvoie que son empreinte
  (`••••3f2a`), sa provenance et sa date : à l'écran, elle est remplaçable,
  jamais relisible.

L'écran est réservé aux comptes standards : le rôle `comptable` n'atteint ni
`/reglages` ni `/api/settings` (liste blanche dans `proxy.ts`).

Le bouton **Tester** de chaque moteur envoie un ping à un token — de quoi
savoir qu'une clé est bonne sans l'apprendre au milieu d'un scan de facture.

### Base de données

1. Nouveau projet : exécuter `db/schema.sql` dans Supabase → SQL Editor.
2. Projet existant : exécuter **une fois** `db/migration_consolidee.sql` (idempotent,
   ré-exécutable sans risque). Elle crée toutes les colonnes/tables que le code attend.
3. Créer le bucket Storage **`invoice-files`** (public) pour les fichiers de factures.
4. Module frais kilométriques : exécuter `db/migration_trajets.sql`.
5. Clés IA gérées depuis l'application : exécuter `db/migration_ai_settings.sql`.

> ⚠️ La migration consolidée est à **ré-exécuter** après une mise à jour qui
> ajoute une catégorie bancaire : la contrainte `CHECK` de `bank_transactions`
> refuse sinon la nouvelle valeur, et la dépense retombe en « non classé » sans
> message. Les dernières ajoutées sont `investissement` et `flux_financier`.

## Déploiement

Le projet est hébergé sur **Vercel** (`qentina-saas.vercel.app`), branché sur ce dépôt GitHub :
**tout merge sur `main` déclenche un déploiement en production**, et chaque pull request obtient
son propre déploiement de prévisualisation.

Cette liaison se règle dans *Vercel → Settings → Git → Connected Git Repository*. Si elle est
absente, Vercel ne publie que ce qu'on lui envoie manuellement en ligne de commande (`vercel`), et
les merges sur GitHub restent invisibles en ligne — le symptôme est un `404` sur une page pourtant
présente dans le dépôt. C'est arrivé une fois ; le réflexe est de vérifier cet écran avant de
chercher le problème dans le code.

Les variables d'environnement vivent dans *Settings → Environments* et sont indépendantes de la
liaison Git : les reconnecter ne les efface pas.

## Synchronisation Square automatique

La caisse se synchronise **toute seule chaque nuit**, il n'y a aucun bouton à cliquer
au quotidien. `vercel.json` déclare le travail planifié :

```json
{ "crons": [{ "path": "/api/cron/square-sync", "schedule": "0 1 * * *" }] }
```

**L'horaire est en UTC** — Vercel Cron ne gère pas les fuseaux. `0 1 * * *` donne
2 h du matin à Paris en hiver et 3 h en été. Les deux tombent après le service et
avant l'ouverture, ce qui est le seul point qui compte.

La fenêtre couvre les **45 derniers jours**, pas l'année : elle englobe le mois
courant et le précédent en entier — la période utile pour une déclaration de TVA —
et se termine toujours largement dans le temps imparti. Une reprise annuelle chaque
nuit serait lente et risquerait d'être coupée en cours de pagination, ce qui
minorerait le chiffre d'affaires sans le signaler.

Pour remonter plus loin, *Réglages → Historique Square* permet une reprise ponctuelle
sur 3, 6 ou 12 mois. L'opération est rejouable : l'upsert sur `square_order_id`
ne crée jamais de doublon.

### Diagnostiquer un chiffre d'affaires incomplet

Le bouton *Diagnostiquer l'écart* (même écran) interroge Square et compare, sur la
même fenêtre, ce que la caisse contient et ce que la base contient. Il répond à la
question que la reprise ne résout pas :

| Cause | Reprise utile ? |
|---|---|
| Commandes non importées sur la boutique configurée | **oui** |
| Une deuxième boutique Square active, jamais lue | **non** — l'import ne connaît qu'un `SQUARE_LOCATION_ID` |
| Commandes payées restées `OPEN` côté Square | **non** — l'import ne prend que `COMPLETED` |

Les deux derniers cas ne se rattrapent pas : ils se corrigent dans Square ou dans la
configuration. Relancer une reprise à l'aveugle donne l'illusion d'avoir agi.

**`CRON_SECRET` est obligatoire.** Vercel ajoute l'en-tête
`Authorization: Bearer $CRON_SECRET` à ses appels dès que la variable existe. Sans
elle, la route refuse de travailler (503) au lieu de rester ouverte — elle écrit en
base et consomme l'API Square.

## Contrôles comptables

```bash
npm run verify:compta
```

171 contrôles de non-régression sur les calculs de TVA, la classification des
écritures, le lettrage et la détection des anomalies. **À lancer après toute
modification touchant `src/lib/tva.ts`, `src/lib/accounting.ts`,
`src/lib/bank-csv.ts`, `src/lib/interventions.ts`, `src/lib/reconciliation.ts`,
le P&L ou le tableau de bord.** Chaque contrôle correspond à une erreur qui a
réellement été commise : TVA déduite sans facture, ventilation par taux ne
réconciliant pas avec son total, taux à 7 % classé en 5,5 %, encaissement traité
comme un achat, coût matières HT divisé par un chiffre d'affaires TTC, dépenses
et encaissements se compensant dans un même compteur, encaissement Square
proposé en lettrage d'une facture EDF, « 28 jours sans vente » comptés le 3 du
mois, chiffre d'affaires annuel lu sur 1 000 commandes au lieu de 1 788. Les
données sont synthétiques, aucune base n'est requise.

Trois règles structurent la comptabilité de l'outil, et ne doivent pas être
contournées :

1. **Le chiffre d'affaires vient de Square.** Un encaissement bancaire n'est pas
   une vente : prêts, apports et virements de trésorerie arrivent sur le même
   compte.
2. **La TVA déductible vient des factures.** L'article 271 du CGI subordonne la
   déduction à une facture. Estimer la TVA depuis un libellé bancaire fabrique un
   droit à déduction qui n'existe pas.
3. **Tout ratio se calcule HT sur HT.** Les lignes de facture sont en HT, les
   mouvements bancaires en TTC, les commandes Square en TTC. Les trois fonctions
   de conversion (`orderHtAmount`, `bankAmountHt`, `makeInvoiceMatcher` dans
   `lib/accounting.ts`) sont le seul passage autorisé d'une base à l'autre — le
   P&L et le tableau de bord affichaient sinon deux food cost différents pour le
   même mois.

## Module « À faire » (interventions)

La page d'accueil s'ouvre sur la liste de ce qui **empêche les chiffres d'être
justes** : caisse désynchronisée, ventes manquantes, dépenses sans facture,
compte courant d'associé débiteur… Chaque ligne dit ce que le chiffre faux fait
croire, l'action à mener, et pointe l'écran où la mener.

Les règles vivent dans `src/lib/interventions.ts`. `detectInterventions` est une
**fonction pure** : elle reçoit des faits et renvoie des constats, sans toucher
ni à la base ni à l'horloge. C'est ce qui permet de la tester dans les deux sens
— elle se déclenche quand il faut, et elle se **tait** quand tout va bien.

Deux principes pour ajouter une règle :

- **Aucune intervention sans preuve arithmétique.** Exemple : un versement Square
  ne contient que les paiements par carte, commission déjà déduite ; le CA TTC
  est donc forcément supérieur au total versé. S'il est inférieur, il manque des
  ventes — sans hypothèse, sans taux supposé.
- **Une alerte qui se déclenche à tort est pire que pas d'alerte.** Ajouter le
  cas « tout va bien » au fichier de contrôle en même temps que la règle.

Tant qu'une intervention **critique** est ouverte, les alertes de pilotage
(food cost au-dessus de la cible, TVA à provisionner) sont masquées : annoncer un
problème de gestion alors que le chiffre d'affaires est incomplet envoie chercher
une cause qui n'existe pas.

## Architecture

```
src/
├── proxy.ts                  # Auth globale (pages → redirect, API → 401) + rôle comptable
├── app/
│   ├── (dashboard)/          # Les 12 pages de l'application (accueil = module « À faire »)
│   ├── api/
│   │   ├── square/           # sync (rattrapage), webhook (signé HMAC), import-catalog
│   │   ├── scanner/          # Analyse (étape 1) + confirm (étape 2) + health
│   │   ├── bank/             # extract (relevé → transactions), recategorize (réapplique les règles)
│   │   ├── cron/             # Travaux planifiés (synchro Square nocturne, CRON_SECRET)
│   │   ├── ai/               # Insights ventes, audit du référentiel ingrédients
│   │   ├── suppliers/merge   # Fusion de deux fiches fournisseur
│   │   ├── settings/ai       # Clés API des moteurs IA (chiffrées), test de clé
│   │   └── chat/             # Fuego (contexte chiffré du mois injecté)
│   └── globals.css           # Design system (variables, composants, responsive)
├── components/
│   ├── ui.tsx                # KpiCard, Modal, ChartCard, PeriodSelector, etc.
│   ├── Interventions.tsx     # Module « À faire » de l'accueil (signal d'alerte)
│   └── Sidebar.tsx           # Navigation desktop + bottom-nav mobile
└── lib/
    ├── supabase/             # Clients + requireUser() + fetch-all (pagination)
    ├── square.ts             # API Square + écriture des commandes (sync ET webhook)
    ├── invoices.ts           # Enregistrement de facture (un seul chemin : le Scanner)
    ├── ai/                   # Prompt OCR unique, parseur JSON robuste
    ├── accounting.ts         # Flux financiers, taux indicatifs, conversions HT
    ├── interventions.ts      # Ce qui empêche les chiffres d'être justes (fonction pure)
    ├── reconciliation.ts     # Lettrage facture ↔ paiement + total des débits
    ├── bank-csv.ts           # Lecture du relevé + règles de catégorisation
    ├── tva.ts                # Calcul TVA (source de vérité unique)
    ├── square-sync.ts        # Import des commandes (cron + rattrapage manuel)
    ├── recipes.ts            # Coût des recettes + conversion d'unités (anti-cycle)
    └── utils.ts              # Formats €/dates, fuseau Europe/Paris, CSV
```

### Le plafond des 1 000 lignes

**Supabase tronque toute réponse à 1 000 lignes, sans le signaler.** `error` reste
nul et le tableau est parfaitement valide — simplement incomplet. Sur un exercice
de 1 788 commandes, le chiffre d'affaires affiché était amputé de 44 %, et comme
le CA est le dénominateur de tous les ratios, le food cost et la masse salariale
étaient gonflés d'autant pendant que la TVA collectée était minorée.

Le symptôme reconnaissable est un **compte exactement rond** : 1 000 commandes,
1 000 écritures. Une donnée réelle ne tombe pas sur un compte rond ; une limite,
si.

Toute lecture dont le volume dépend d'une période, d'un volume de ventes ou d'un
historique passe donc par `fetchAllRows` (`src/lib/supabase/fetch-all.ts`), qui
pagine avec `.range()`. Quand le filtre est un `in(...)` sur une longue liste
d'identifiants, `fetchAllRowsIn` découpe **aussi** la liste : 1 788 UUID dans une
URL font 66 Ko, au-delà de ce que les passerelles HTTP acceptent.

Seules peuvent s'en dispenser les requêtes bornées par construction : un
`.limit(n)` avec n ≤ 1 000, un `.eq()` sur une clé primaire, une table de
réglages. Attention — un `.limit(2000)` **ne fonctionne pas** : le serveur en
rend 1 000 sans broncher.

Le faux client Supabase de `npm run verify:compta` applique le même plafond,
pour que le défaut soit visible en test.

### Principes à respecter (pour les évolutions futures)

1. **Une logique = un seul endroit.** Tout calcul partagé vit dans `src/lib/`, jamais copié
   dans une page. (TVA → `lib/tva.ts`, coût recette → `lib/recipes.ts`, etc.)
2. **Toute route API commence par `requireUser()`** — sauf le webhook Square (signé HMAC).
3. **Écritures Square uniquement via `lib/square.ts`** pour que synchro et webhook restent identiques.
4. **Pas de « fallback schéma »** : si une colonne manque, on l'ajoute dans
   `db/migration_consolidee.sql`, on ne code pas de plan B.
5. **UI : composants de `components/ui.tsx` + classes de `globals.css`** plutôt que des
   styles inline dupliqués.

## Utilisateurs & rôles

- Compte standard : accès à tout.
- Rôle `comptable` (metadata `role: "comptable"` sur l'utilisateur Supabase) : accès limité à
  Factures / TVA / Banque / CCA / P&L (+ APIs correspondantes), appliqué par `proxy.ts`.
