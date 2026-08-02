# 🍕 QENTINA — Pilotage de pizzeria

SaaS de gestion pour pizzeria napolitaine : ventes Square, scanner de factures par IA,
banque, TVA, P&L, comptes d'associés, stock, fiches techniques, menu engineering,
avis Google et assistant IA « Fuego ».

> 📋 **Nouveau ici ?** Lis [`AUDIT.md`](./AUDIT.md) : il explique l'architecture, les choix
> et tout ce qui a été corrigé lors de la grande révision d'août 2026.

## Stack

- **Next.js 16** (App Router, `proxy.ts` pour l'auth) + React 19 + TypeScript strict
- **Supabase** : base Postgres + Auth + Storage (fichiers de factures)
- **Square** : source des ventes (synchro manuelle + webhook temps réel)
- **Anthropic Claude** : OCR de factures/relevés, audits, chat Fuego
- **Google** : avis (Places API) + réponses (My Business API, OAuth)

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
| `ANTHROPIC_API_KEY` | Clé API Claude (scanner, banque, Fuego, audits) |
| `SQUARE_ACCESS_TOKEN` | Jeton d'accès Square |
| `SQUARE_LOCATION_ID` | Identifiant du point de vente Square |
| `SQUARE_WEBHOOK_SECRET` | **Important** : secret de signature du webhook (Square Developer Dashboard) |
| `NEXT_PUBLIC_APP_URL` | URL publique de l'app (ex. `https://…vercel.app`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Google Business (réponses aux avis) |
| `GOOGLE_PLACES_API_KEY` / `GOOGLE_PLACE_ID` | Lecture des avis Google |

### Base de données

1. Nouveau projet : exécuter `db/schema.sql` dans Supabase → SQL Editor.
2. Projet existant : exécuter **une fois** `db/migration_consolidee.sql` (idempotent,
   ré-exécutable sans risque). Elle crée toutes les colonnes/tables que le code attend.
3. Créer le bucket Storage **`invoice-files`** (public) pour les fichiers de factures.

## Architecture

```
src/
├── proxy.ts                  # Auth globale (pages → redirect, API → 401) + rôle comptable
├── app/
│   ├── (dashboard)/          # Les 15 pages de l'application
│   ├── api/
│   │   ├── square/           # sync (365 j), webhook (signé HMAC), import-catalog
│   │   ├── scanner/          # Analyse (étape 1) + confirm (étape 2) + health
│   │   ├── invoices/extract  # Import direct (analyse + enregistrement en 1 appel)
│   │   ├── bank/extract      # Relevé bancaire (PDF/CSV) → transactions
│   │   ├── ai/               # Insights ventes, audit stock, réponses aux avis
│   │   ├── chat/             # Fuego (contexte chiffré du mois injecté)
│   │   └── google/           # OAuth (state anti-CSRF) + avis
│   └── globals.css           # Design system (variables, composants, responsive)
├── components/
│   ├── ui.tsx                # KpiCard, Modal, ChartCard, PeriodSelector, etc.
│   └── Sidebar.tsx           # Navigation desktop + bottom-nav mobile
└── lib/
    ├── supabase/             # Clients (browser, server, service-role) + requireUser()
    ├── square.ts             # API Square + écriture des commandes (sync ET webhook)
    ├── invoices.ts           # Enregistrement de facture unifié (scanner + import direct)
    ├── ai/                   # Prompt OCR unique, parseur JSON robuste
    ├── tva.ts                # Calcul TVA (source de vérité unique)
    ├── recipes.ts            # Coût des recettes + conversion d'unités (anti-cycle)
    └── utils.ts              # Formats €/dates, fuseau Europe/Paris, CSV
```

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
