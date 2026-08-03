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

## 6 bis. Déploiement (Vercel)

L'app tourne sur Vercel. Deux points valent d'être connus :

- **`src/middleware.ts` n'existe plus** : renommé en **`src/proxy.ts`**, la convention officielle de
  Next.js 16 (`middleware` y est déprécié, un codemod dédié existe). Vérifié sur un vrai serveur de
  production : `/dashboard` renvoie bien 307 vers `/login`, les API renvoient 401, `/login` reste
  accessible. Pense à corriger ta documentation interne si elle cite l'ancien nom.
- **Les déploiements de prévisualisation** ont une URL différente à chaque branche : le webhook
  Square n'y sera pas validé. C'est normal, seule la production reçoit les événements Square.

### `NEXT_PUBLIC_APP_URL` : la variable qui casse tout en silence

Elle sert à **deux vérifications de sécurité** : la signature HMAC du webhook Square, et la
redirection OAuth Google. Si elle manquait, la signature était calculée sur
`undefined/api/square/webhook` et Square recevait un `401 Invalid signature` — un message trompeur
qui accuse Square alors que la cause est une variable oubliée.

Le code est désormais défensif (`src/lib/env.ts`) :

| Situation | Comportement |
|---|---|
| Variable définie | Fonctionnement normal |
| Absente, mais sur Vercel | Repli automatique sur `VERCEL_PROJECT_PRODUCTION_URL` + avertissement dans les logs |
| Absente hors Vercel, en production | **503** explicite (« Configuration serveur incomplète ») au lieu d'un 401 trompeur ; Square réessaiera une fois la variable ajoutée |
| Absente en développement | `http://localhost:3000` |

**Pour vérifier ta configuration sans attendre une panne** : connecte-toi puis ouvre
`/api/scanner/health`. Le bloc `config` liste les variables manquantes et leur impact, sans jamais
révéler la moindre valeur secrète.

```json
{ "config": { "ok": true, "app_url": "https://…", "missing_required": [], "missing_optional": [] } }
```

## 6 ter. Frais kilométriques (nouveau module)

Page **Frais kilométriques** (`/trajets`) : calcule ce que la société te doit pour l'usage de ton
véhicule personnel lors des courses, et produit une note de frais imprimable.

**Détection automatique.** Le bouton « Détecter » parcourt tes factures de l'année et crée un
aller-retour par déplacement :

| Fournisseur sur la facture | Trajet généré |
|---|---|
| Metro (ou « Métro ») | Louviers ↔ Sotteville-lès-Rouen |
| Mozzalat (ou « Eurocibus », ancienne raison sociale) | Louviers ↔ Évreux |

Règle appliquée : **un trajet par jour et par fournisseur**. Deux factures Metro le même jour ne
comptent donc qu'un seul aller-retour. Un index unique en base garantit qu'une relance de la
détection ne crée jamais de doublon.

**Deux pièges de calcul évités.** Le barème kilométrique est progressif *par tranche annuelle* : le
taux dépend du total de kilomètres de l'année, pas de chaque trajet isolément — ajouter un trajet
peut donc changer le taux de tous les autres. Le calcul porte toujours sur le cumul annuel. Par
ailleurs, la ventilation par ligne utilise la méthode du plus fort reste, pour que la somme des
lignes égale le total **au centime près** (un arrondi ligne par ligne dérivait de 7 centimes sur
104 trajets).

**Impression.** Le bouton « Imprimer » ouvre la boîte d'impression du navigateur ; « Enregistrer au
format PDF » produit un vrai fichier PDF. Aucune bibliothèque supplémentaire n'a été ajoutée : le
document est mis en page en CSS (`@media print`), avec en-tête, détail des déplacements, barème
appliqué et emplacements de signature. Les en-têtes de tableau se répètent sur chaque page.

**La détection lit le relevé bancaire ou les factures — jamais les deux.** Un achat laisse deux
traces qui décrivent le *même* déplacement : les cumuler compterait chaque trajet en double. La
source se choisit dans les réglages, et le relevé est la valeur par défaut : toute dépense y figure,
alors qu'une facture n'existe que si elle a été scannée.

Une subtilité qui change les dates : **la banque date l'écriture, pas l'achat**. Un paiement par
carte est débité un à trois jours après le passage en caisse, et un règlement à terme peut arriver
des mois plus tard — sur un relevé réel, une ligne « Metro 27/03 » a été débitée le 1ᵉʳ juin. La
détection récupère donc la date collée au libellé quand il y en a une (`CB42METRO FRANCE 04/06/26`),
et signale les trajets pour lesquels elle a dû se rabattre sur la date de paiement.

Au passage, la reconnaissance des fournisseurs ignore désormais les espaces : la banque écrit
« EURO CIBUS » là où la facture porte « Eurocibus ». Sans cela, dix prélèvements passaient à la
trappe en silence.

**Tout est paramétrable** (bouton « Réglages » de la page) : source de détection, identification du
véhicule, distances,
péages, puissance fiscale, motorisation, termes reconnus par fournisseur, et les taux du barème — ce
dernier étant révisé chaque année par l'administration, le figer dans le code aurait créé un piège de
maintenance.

**Le véhicule.** Les réglages sont pré-remplis d'après la carte grise du **Pössl Summit 600
(GA-175-LB, 1ʳᵉ immatriculation le 30/06/2021)** :

| Case | Valeur | Conséquence |
|---|---|---|
| **P.6** | 7 | Barème « 7 CV et plus » — la tranche la plus élevée, le barème plafonne là |
| **P.3** | GO (gazole) | Thermique : pas de majoration de 20 % |
| **J** | M1 | Véhicule de tourisme — **ce n'est pas un utilitaire N1/CTTE** |
| **J.1 / J.3** | VASP / CARAVANE | Van aménagé sur base Citroën Jumper |
| **C.1** | DE FARIA Yohan | Titulaire — Justine conduit, même foyer fiscal, donc admis |

Le véhicule est imprimé sur la note de frais (modèle, immatriculation, puissance fiscale) : un
document qui ne désigne pas le véhicule est faible en cas de contrôle.

**Lien avec les Comptes Courants d'Associés.** Tant que le virement n'est pas fait, la société doit
cet argent à l'associé : un bandeau affiche le montant dû et le bouton « Porter au compte courant »
crée le mouvement correspondant (apport, sous-type « frais perso »). Le calcul se fait en
**différentiel** — total dû moins déjà porté — ce qui gère proprement le cas où l'on enregistre en
plusieurs fois : franchir 5 000 km en cours d'année recalcule le taux de tous les trajets, et l'écart
est rattrapé au prochain enregistrement au lieu d'être perdu. Le jour où le virement est effectué, il
se saisit comme un remboursement depuis la page Comptes Associés, comme n'importe quel autre
mouvement.

⚠️ **Un seul point reste à valider :** les **distances sont pré-remplies avec des estimations**
(56 km et 60 km aller-retour). Vérifie-les sur un calculateur d'itinéraire avec tes adresses exactes :
en cas de contrôle, la distance doit être justifiable. Le péage Metro reste à 0 € tant que tu ne l'as
pas saisi.

✅ **Titulaire et conducteur.** La carte grise est au nom de Yohan alors que Justine conduit. C'est
admis, Justine et Yohan étant du même foyer fiscal : l'indemnité se rembourse au propriétaire du
véhicule ou à une personne de son foyer. La note de frais le mentionne explicitement (« titulaire :
Yohan — même foyer fiscal ») plutôt que de laisser la question ouverte à un lecteur extérieur. Le
réglage « même foyer fiscal » reste modifiable : basculé sur *non*, la page alerte dès que le
conducteur sélectionné n'est pas le titulaire, pour éviter de créditer le mauvais compte courant.

✅ **Le doute sur le type de véhicule est levé.** La carte grise indique J = M1 et J.1 = VASP : c'est
un véhicule de tourisme, pas une camionnette « CTTE ». Le cas qui aurait imposé les frais réels au
lieu du barème ne s'applique donc pas. La puissance fiscale (P.6 = 7) est celle qui était déjà
retenue : aucun montant n'est à recalculer.

## 7. ⚠️ ACTION REQUISE DE TA PART

1. **Exécute `db/migration_consolidee.sql`** dans Supabase → SQL Editor (une seule fois).
   Le code n'a plus de « plan B » : sans cette migration, l'enregistrement de factures échouera.
2. **Ajoute `NEXT_PUBLIC_APP_URL`** dans Vercel → Settings → Environment Variables (Production),
   avec ton domaine exact, sans barre oblique finale. Elle doit être identique dans le Square
   Developer Dashboard et la Google Cloud Console.
3. **Vérifie que `SQUARE_WEBHOOK_SECRET` est bien renseigné** dans tes variables d'environnement
   (Vercel) — c'est lui qui authentifie les événements envoyés par Square.
4. Redéploie, puis ouvre `/api/scanner/health` (connecté) : le bloc `config` doit afficher
   `"ok": true`.

### Un piège PostgreSQL rencontré une fois, à connaître

La détection automatique des trajets échouait alors que la base répondait normalement. La cause :
`ON CONFLICT (colonne)` ne sait **pas** se rattacher à un index **partiel** ni à un index
**d'expression**. PostgreSQL répond alors `there is no unique or exclusion constraint matching the
ON CONFLICT specification`, et l'insertion entière est rejetée.

L'index anti-doublon des trajets était partiel (`WHERE dedupe_key IS NOT NULL`) : il est désormais
simple. Ça ne change rien à la protection recherchée, les NULL étant distincts entre eux par défaut
en PostgreSQL — les saisies manuelles peuvent donc rester nombreuses.

**Le même piège existait sur `idx_bank_transactions_unique`**, un index d'expression
(`lower(trim(regexp_replace(description…)))`) visé par un `ON CONFLICT (date, description, amount)`.

Je l'avais d'abord jugé bénin : la route `api/bank/extract` avait un repli ligne à ligne, donc
« lent mais pas cassé ». **C'était faux.** L'insertion groupée échouant systématiquement, chaque
import repartait sur un aller-retour par ligne — 177 requêtes séquentielles pour un relevé de deux
mois. Assez lent pour que la fonction soit interrompue en cours de route : sur un import réel, les
78 lignes de juin sont passées et les 99 de juillet ont disparu, sans le moindre message d'erreur.
La moitié d'un relevé manquait et l'écran annonçait un succès.

Correction : plus de `onConflict` du tout. Un `INSERT` simple n'a besoin d'aucune inférence et
fonctionne avec cet index ; les doublons connus sont déjà retirés en amont par la comparaison avec
la base. L'insertion se fait par lots de 50 — **4 requêtes au lieu de 177** — et seul un lot
réellement en conflit est rejoué ligne à ligne. Enfin, si des lignes manquent à l'arrivée, la
réponse le dit au lieu d'annoncer un import complet.

La leçon vaut d'être notée : un repli qui « rattrape » une erreur peut la transformer en panne plus
discrète. Ici, il changeait un échec franc en perte silencieuse de données.

### Réponses IA tronquées : le bug le plus dangereux trouvé

Toutes les extractions IA étaient plafonnées à **4 096 tokens de réponse**. Au-delà, Claude s'arrête
au milieu du JSON. Or le parseur partagé « répare » un JSON tronqué en le refermant au dernier objet
complet — le résultat est un JSON valide, accepté sans erreur, **amputé de sa fin**.

Conséquence : un relevé bancaire ou une facture trop longue entrait en base **incomplet et
silencieusement**. Pas de message, pas d'échec — juste des lignes manquantes. Sur une facture Metro
de plus de cent lignes, cela fausse le stock, la liste de courses et la TVA sans qu'aucun indicateur
ne bouge. C'est plus grave qu'une erreur visible : une erreur, on la corrige ; une donnée
silencieusement fausse, on la comptabilise.

Trois corrections :

1. **Plafond porté à 32 000 tokens** sur l'import bancaire et l'OCR de factures.
2. **Appels en streaming** (`lib/anthropic.ts`) : au-delà d'environ 16 000 tokens de sortie, une
   requête classique dépasse le délai HTTP du SDK et échoue sans rien renvoyer. Le streaming lève ce
   plafond ; la réponse obtenue est identique.
3. **Troncature détectée et refusée.** Si Claude s'arrête sur la limite, l'import est rejeté avec un
   message qui dit quoi faire (découper le relevé, scanner la facture en deux). Mieux vaut un refus
   explicite qu'un import incomplet.

Le message d'erreur de l'import bancaire renvoie désormais la cause réelle : il se contentait d'un
« Erreur extraction banque » qui ne laissait qu'un code 500 à l'écran.

### Le CSV bancaire est désormais lu directement, sans IA

Un relevé exporté en CSV est **déjà structuré**. Le faire retranscrire ligne à ligne par une IA
revenait à accepter un risque d'erreur sur des montants, pour un travail qu'une lecture de fichier
fait exactement. Sur un relevé réel de deux mois (177 opérations), cela demandait environ 8 000
tokens de réponse — au-dessus de l'ancien plafond, d'où l'échec.

`src/lib/bank-csv.ts` lit le fichier directement : dates et montants sont exacts par construction.
L'IA ne reçoit plus que les **libellés distincts** — 64 au lieu de 177 lignes — et ne fait que ce
qu'elle fait mieux qu'une règle : deviner la catégorie comptable. Si le format n'est pas reconnu, le
code retombe automatiquement sur l'extraction par IA ; les relevés PDF continuent de passer par elle.

**Un second bug est apparu à la lecture du vrai fichier :** les lignes 1 et 179 ne sont pas des
opérations mais les **soldes d'ouverture et de clôture**. Elles portent une date et un montant
valides, et l'IA les importait comme deux recettes fantômes — faussant le rapprochement bancaire.
Le lecteur les écarte (elles n'ont que quatre colonnes au lieu de huit).

Contrôle de cohérence sur le relevé réel, la banque fournissant elle-même la somme de contrôle :

| | |
|---|---|
| Solde d'ouverture imprimé | 1 768,44 € |
| + somme des 177 opérations lues | 477,46 € |
| = solde recalculé | **2 245,90 €** |
| Solde de clôture imprimé | **2 245,90 €** |

Concordance au centime. Ré-importer le même fichier n'ajoute aucune ligne.

**La catégorisation passe d'abord par des règles locales.** Les libellés bancaires sont très
répétitifs : une table de motifs (Square, Metro, Eurocibus, Carrefour, Urssaf, EDF, Verisure…)
couvre les deux tiers des lignes instantanément et gratuitement. L'IA ne reçoit que les libellés
inhabituels — 46 au lieu de 177 lignes.

Conséquence utile, découverte le jour où le compte Anthropic s'est retrouvé à court de crédit :
**l'import bancaire fonctionne même sans IA du tout.** Sur le relevé réel, sans un seul appel API,
177 opérations sont importées avec des montants exacts et 120 d'entre elles déjà catégorisées, dont
la totalité des encaissements Square. Les 57 restantes arrivent en « autre » et la réponse le
signale. Un outil de gestion qui s'arrête net parce qu'un service tiers est indisponible est un
outil fragile ; celui-ci se contente de perdre en confort.

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
