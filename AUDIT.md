# 🔍 Audit complet — QENTINA (SaaS de pilotage pizzeria)

*Audit réalisé le 2 août 2026. Ce document explique ce que l'application fait, ce qui a été trouvé
lors de l'analyse complète du code (16 500 lignes), et ce qui a été corrigé.*

---

## 1. Ce que tu as construit (et c'est déjà beaucoup)

Ton application couvre **tout le pilotage d'une pizzeria** :

| Module | Ce qu'il fait |
|---|---|
| **Dashboard** | CA, ticket moyen, food cost, masse salariale, EBE, TVA, heatmap midi/soir, simulateur de marge |
| **Ventes** | Analyse Square avec comparaison "like-for-like" vs période précédente, insights IA |
| **Scanner IA** | Photo/PDF d'une facture → Claude lit tout (fournisseur, lignes, TVA, compte comptable) → vérification → enregistrement + rapprochement bancaire |
| **Factures** | Liste, recherche, détail des lignes, mode de règlement (banque / espèces / CB perso) |
| **Banque** | Import de relevés (IA), catégorisation, pointage facture ↔ transaction, scission de transactions |
| **TVA** | TVA collectée (taux réels Square) vs déductible (factures + banque), règle des tickets > 150 € |
| **P&L** | Compte de résultat complet avec drill-down par poste et masquage d'écritures |
| **CCA** | Comptes courants d'associés (Justine / Yohan) avec solde cumulé et alerte compte débiteur |
| **Stock** | Inventaire physique par rayon, stock théorique (achats − consommation), audit IA des anomalies |
| **Fiches techniques** | Recettes avec sous-recettes (pâte, sauces), coût matière, food cost par plat |
| **Menu Engineering** | Matrice popularité × marge (Stars / Vaches à lait / Puzzles / Poids morts) |
| **Liste de courses** | Catalogue reconstruit depuis l'historique de factures, listes multiples |
| **Avis Google** | Lecture des avis + génération de réponses par IA |
| **Fuego** | Chat IA avec tes chiffres du mois injectés en contexte |

La vision est **cohérente et intelligente** : Square alimente les ventes, le scanner alimente les
achats, la banque fait le pont, et tout converge vers le food cost, la TVA et l'EBE. C'est
exactement comme ça qu'un logiciel de gestion de restaurant doit être pensé.

## 2. Pourquoi c'était devenu une « usine à gaz »

Le problème n'était pas la vision, mais l'accumulation de code généré au fil des demandes :

1. **La même logique existait en plusieurs exemplaires qui divergeaient.**
   - Le calcul TVA existait 2 fois (lib + page TVA) — et donnait **des chiffres différents**
     sur le dashboard et sur la page TVA (le dashboard ignorait ton marquage « TVA non récupérable »).
   - Le calcul du coût d'une recette existait **5 fois** (4× dans Fiches techniques, 1× dans Menu Engineering).
   - Le prompt d'OCR de facture existait 2 fois (2 routes API différentes pour le même travail).
   - Le plan comptable (601, 607, 606…) était copié dans 3 pages, avec des listes différentes.
   - Le scoring de rapprochement bancaire existait 3 fois (serveur + 2 copies client).
2. **Trois chemins différents pour importer une facture** (Scanner, Factures, Banque), chacun avec
   ses propres écritures en base — la page Banque ré-écrivait même par-dessus ce que le serveur
   venait de faire, ce qui pouvait **rapprocher 2 transactions différentes de la même facture**.
3. **Des « plans B » partout** : le code tentait d'insérer avec les nouvelles colonnes, échouait si
   la migration SQL n'avait pas été jouée, puis réessayait avec les anciennes colonnes. Résultat :
   du code doublé et des données incomplètes selon le chemin pris.
4. **25 scripts de débogage** accumulés à la racine (`check-square.mjs`, `fix-units.mjs`…) et
   5 fichiers SQL de migration éparpillés.

## 3. Bugs réels trouvés (et corrigés)

### Bugs de données / calculs
| Bug | Impact | Correction |
|---|---|---|
| Dashboard « Top produits » lisait une colonne inexistante (`gross_sales_money`) | Le CA par produit était toujours vide | Lecture de `total_price` (la vraie colonne) |
| Heure codée en dur `UTC+2` pour le split midi/soir | Faux la moitié de l'année (heure d'hiver) | Fuseau `Europe/Paris` réel (`getParisHour`) |
| Page Ventes : date « aujourd'hui » calculée en UTC | Après 22h/23h, le bouton « Aujourd'hui » pointait sur **hier** | Date locale |
| Comparaison LFL : débordement de mois (pivot au 31) | La période précédente incluait des jours du mois courant | Bornage au dernier jour du mois |
| Menu Engineering : formule du « prix idéal » inversée | Conseillait un prix de **4,29 €** au lieu de **10 €** (coût 3 €, marge 70 %) | `coût / (1 − marge)` |
| Stock : grammes des recettes soustraits aux kilos des factures | Stocks théoriques absurdes (−14 980 au lieu de +5) | Conversion d'unités systématique |
| TVA dashboard ≠ TVA page TVA | Deux chiffres différents pour la même chose | Une seule lib `computeTva`, qui respecte ton marquage « non récupérable » |
| Récursion infinie possible si recette A contient B qui contient A | Page figée (plantage navigateur) | Protection anti-cycle |
| Webhook Square n'enregistrait pas `raw_data` | La TVA des commandes temps réel était **estimée** au lieu d'exacte | Le webhook stocke désormais les taxes réelles |

### Bugs d'interface
| Bug | Impact | Correction |
|---|---|---|
| Photo iPhone (HEIC) envoyée telle quelle à l'IA | L'API refuse le format → « Erreur scanner » sans explication | Formats validés + message expliquant le réglage iPhone à changer |
| Banque : une **photo** de relevé était envoyée comme PDF | L'import échouait systématiquement | Formats réels acceptés (PDF + CSV) |
| CCA : champ fichier `required` mais masqué | **Impossible d'ajouter un apport manuel** dans Chrome (le formulaire bloquait sans message) | Corrigé |
| Avis Google : « Génération en cours... » restait dans le champ de réponse | Un clic pouvait **publier ce texte sur Google** publiquement | État de génération séparé, boutons désactivés |
| Avis sans note affichés « 1 étoile » | Fausse lecture des avis | Mapping complet des notes |
| Fuego mobile : zone de saisie cachée sous la barre de navigation | Chat inutilisable sur téléphone | Hauteur recalculée avec la barre mobile |
| Bulles du chat et encadrés d'avis transparents (variables CSS inexistantes) | Blocs invisibles | Variables corrigées + alias de secours |
| Modale « Détail des charges » du dashboard sans style (classes inexistantes) | Modale cassée | Composant Modal partagé |
| Fiches techniques : après suppression d'une ligne d'ingrédient, les champs affichaient les anciennes valeurs | Risque d'enregistrer une recette fausse | Champs contrôlés avec clés stables |

## 4. Sécurité — analyse et corrections

### ✅ Ce qui était déjà bien
- Authentification Supabase avec middleware sur toutes les pages.
- RLS (Row Level Security) activée sur toutes les tables.
- Clé `service_role` uniquement côté serveur, jamais exposée au navigateur.
- Rôle « comptable » limité aux pages Finance.

### 🔴 Failles corrigées
1. **Webhook Square contournable** : la signature n'était vérifiée que si l'en-tête était présent —
   un attaquant qui *omettait* l'en-tête passait sans vérification. Désormais : secret configuré ⇒
   signature obligatoire et comparaison à temps constant (anti timing-attack).
2. **Routes API sans garde propre** : la protection reposait uniquement sur le middleware. Chaque
   route vérifie maintenant elle-même la session (`requireUser()`) — défense en profondeur.
   Les API renvoient un vrai `401 JSON` au lieu d'une redirection HTML.
3. **`/api/scanner/health` public** : n'importe qui sur Internet pouvait déclencher des appels à
   l'API Anthropic (coût !) et lire des infos sur ton stockage. Route désormais réservée aux
   connectés + ping 25× moins fréquent et sur le modèle le moins cher.
4. **OAuth Google sans protection CSRF** : ajout du paramètre `state` vérifié par cookie httpOnly.
5. **Middleware déprécié** : migration vers la convention `proxy.ts` de Next.js 16.
6. Le rôle comptable référençait des chemins d'API inexistants (`/api/banque` au lieu de
   `/api/bank`) — le comptable ne pouvait pas importer de relevé. Corrigé.

### 🟡 À savoir (choix assumés, pas de faille immédiate)
- Les fichiers de factures sont dans un bucket **public** Supabase : les URLs sont longues et
  impossibles à deviner, mais toute personne ayant une URL peut voir la facture. Pour des documents
  comptables c'est acceptable ; si tu veux du 100 % privé, il faudra passer aux URLs signées.
- Les policies RLS donnent le même accès à tous les comptes authentifiés (accès « famille ») —
  cohérent avec ton usage à 2-3 utilisateurs.
- Si `SQUARE_WEBHOOK_SECRET` n'est pas configuré, le webhook accepte les événements avec un
  avertissement dans les logs. **Configure-le** dans le Square Developer Dashboard.

## 5. Performance

- **Dashboard** : 10 requêtes qui partaient l'une après l'autre → désormais **en parallèle**
  (chargement ~3-4× plus rapide). Pareil pour P&L (9 requêtes), TVA, Stock, Réglages.
- **Boucles N+1 éliminées** : TVA (1 requête par transaction bancaire → 1 requête groupée),
  inventaire (1 INSERT par produit compté → 1 seul INSERT groupé), import catalogue Square
  (1 requête par article → 1 requête).
- **Temps réel** : chaque événement Square/banque rechargeait tout le dashboard → regroupé
  (debounce 2 s).
- **Indicateur « Claude IA »** : ping toutes les 45 s par navigateur ouvert, sur le modèle Sonnet →
  toutes les 5 min, sur Haiku (≈ 25× moins d'appels, modèle ~10× moins cher).

### Modèles d'IA
Le scanner passe de **Sonnet 4.6 à Sonnet 5**, à tarif identique. L'intérêt est concret : Sonnet 5
lit les images en **2576 px** contre 1568 px auparavant, ce qui change tout pour déchiffrer les
petits caractères d'un ticket photographié au téléphone. Le « raisonnement étendu » est
explicitement désactivé (l'extraction de facture n'en a pas besoin) pour éviter toute hausse de
coût. Chaîne de secours si le modèle est saturé : Sonnet 5 → Opus 4.8 → Haiku 4.5.

Pour revenir en arrière, une seule ligne à changer dans `src/lib/anthropic.ts` (`PRIMARY_MODEL`).

## 6. Ce qui a été simplifié

- **1 seul moteur OCR de factures** (`src/lib/ai/invoice-ocr.ts`) au lieu de 2 prompts divergents.
- **1 seule fonction d'enregistrement de facture** (`src/lib/invoices.ts`) utilisée par le Scanner
  ET l'import direct — fournisseur, lignes, référence comptable, CCA, rapprochement : tout au même endroit.
- **1 seule lib Square** (`src/lib/square.ts`) pour la synchro et le webhook.
- **1 seule lib TVA**, **1 seule lib coût recette**, **1 seul parseur JSON IA**.
- **Bibliothèque de composants UI** (`src/components/ui.tsx`) : cartes KPI, modales, tooltips,
  sélecteur de période… Le dashboard est passé de **1 801 à ~900 lignes** à fonctionnalités égales.
- **Base de données** : 5 fichiers SQL éparpillés → `db/schema.sql` (référence) +
  `db/migration_consolidee.sql` (à jouer une fois). Les colonnes que le code utilisait « en
  espérant qu'elles existent » (payment_method…) sont maintenant officiellement créées, et tous
  les « plans B » du code ont été supprimés.
- **Nettoyage** : 25 scripts de débogage et le dossier `scratch/` supprimés (ils restent dans
  l'historique git si besoin).

## 7. ⚠️ ACTION REQUISE DE TA PART

1. **Exécute `db/migration_consolidee.sql`** dans Supabase → SQL Editor (une seule fois).
   Le code n'a plus de « plan B » : sans cette migration, l'enregistrement de factures échouera.
2. **Vérifie que `SQUARE_WEBHOOK_SECRET` est bien renseigné** dans tes variables d'environnement
   (Vercel) — c'est lui qui authentifie les événements envoyés par Square.
3. Redéploie l'application.

## 8. Pistes pour la suite (non faites, à discuter)

- **Réconcilier le CA du Dashboard (TTC) et du P&L (HT)** : les deux pages affichent un « CA »
  calculé différemment. C'est comptablement défendable (vision caisse vs vision comptable) mais
  mérite un libellé explicite ou une harmonisation.
- Stock : les achats et ventes sont cumulés **depuis toujours** — un vrai calcul d'écart devrait
  repartir du dernier inventaire. C'est un chantier métier à part entière.
- Rapprochement produit↔ingrédient par « le nom contient » : fonctionne mais fragile
  (« Tomate » capte « Concentré de tomate »). Une table de correspondance serait plus fiable.
- Historique des inventaires (les comptages sont en base mais aucune page ne les affiche).
- Réglages : ajouter la déconnexion Google et rendre configurables les seuils (food cost cible…).
