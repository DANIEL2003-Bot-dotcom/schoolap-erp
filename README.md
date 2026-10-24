# ERP Scolaire RDC — inspiré de Schoolap

Un ERP scolaire complet, de bout en bout, pensé pour les écoles congolaises (organisation EPST, réseau instable, paiements Mobile Money). Il se déploie gratuitement.

> 🌐 **En ligne** : tableau de bord https://daniel2003-bot-dotcom.github.io/schoolap-erp/ · API https://schoolap-erp-api.onrender.com/api/health
> (base de données PostgreSQL **Neon**, gratuite et sans expiration ; API sur Render, en veille après 15 min d'inactivité)

| Composant | Technologie | Dossier | Déploiement gratuit |
|---|---|---|---|
| Base de données | PostgreSQL + Prisma 6 | `backend/prisma` | Render (PostgreSQL Free) |
| API Gateway | Node 20 + Express 5 | `backend/src` | Render (Web Service Free) |
| Tableau de bord du Directeur + gestion administrative | React 19 + Vite 7 (CSS inline) | `dashboard/src/App.jsx`, `admin.jsx`, `lib.js` | GitHub Pages |
| Application enseignant | Flutter 3 + sqflite | `mobile/lib/main.dart` | APK Android |

```
 ┌────────────────────┐   file d'attente HTTP (outbox sqflite)   ┌──────────────────────┐
 │ App Flutter         │ ───── POST /api/attendance/sync ───────▶ │  API Express (Render) │──▶ SMS (console + SmsLog)
 │ enseignant, hors-   │ ───── POST /api/grades/sync ───────────▶ │  JWT · Zod · Helmet   │
 │ ligne d'abord       │ ◀──── GET  /api/teacher/bootstrap ────── │  rate-limit · CORS    │◀─ Webhook signé HMAC
 └────────────────────┘                                          └──────────┬───────────┘   (M-Pesa / Orange / Airtel)
 ┌────────────────────┐ ── GET /api/dashboard/summary ──────────▶           │ Prisma
 │ Dashboard React     │ ── POST /api/fees/:id/remind ───────────▶ ┌─────────▼────────────┐
 │ (GitHub Pages)      │ ── POST /api/payments/mobile-money ─────▶ │ PostgreSQL (Render)   │
 └────────────────────┘                                            └──────────────────────┘
```

## Captures

| Tableau de bord (données réelles de l'API) | Paiement Mobile Money → webhook → solde mis à jour |
|---|---|
| ![Tableau de bord](docs/dashboard-desktop.png) | ![Paiement](docs/paiement-mobile-money.png) |

| Appel hors ligne (nuage orange = local, coche verte = synchronisé) | Saisie rapide des cotes | Dashboard sur mobile |
|---|---|---|
| ![Appel](docs/mobile-appel.png) | ![Cotes](docs/mobile-cotes.png) | ![Mobile](docs/dashboard-mobile.png) |

| Élèves (inscription, fiche, transfert) | Import CSV vérifié avant écriture |
|---|---|
| ![Élèves](docs/admin-eleves.png) | ![Import](docs/admin-import.png) |

| Classes, personnel et matières | Frais : synthèse et création groupée |
|---|---|
| ![Classes](docs/admin-classes.png) | ![Frais](docs/admin-frais.png) |

---

## 1. Déploiement gratuit en 10 minutes

### 1.1 API + base PostgreSQL sur Render (Blueprint en un clic)

1. Poussez ce dépôt sur GitHub (nom conseillé : `schoolap-erp`).
2. Sur Render, ouvrez **New → Blueprint** et sélectionnez le dépôt. Render lit `render.yaml` et crée :
   - `schoolap-erp-db`, une base PostgreSQL **Free** à Frankfurt ;
   - `schoolap-erp-api`, un service web Node **Free**, avec `rootDir: backend` et un health check sur `/api/health`.
3. Render demande trois valeurs (`sync: false`) :
   - `CORS_ORIGINS` : l'origine de votre dashboard, par exemple `https://moncompte.github.io` (sans chemin, sans `/` final).
   - `SEED_DIRECTOR_PASSWORD` et `SEED_TEACHER_PASSWORD` : les mots de passe des comptes initiaux. Si vous les laissez vides, ce seront `Directeur@2026` et `Enseignant@2026`.
4. `JWT_SECRET` et `WEBHOOK_SECRET` sont générés automatiquement (`generateValue: true`).
5. Au démarrage, `npm run render:start` exécute, dans l'ordre :
   - `prisma migrate deploy` ;
   - le seed **idempotent** (il ne fait rien si l'école existe déjà) ;
   - le lancement du serveur.

   Le plan gratuit ne propose pas `preDeployCommand` : c'est pourquoi migrations et seed passent par la commande de démarrage.

Vérification : `https://schoolap-erp-api.onrender.com/api/health` doit renvoyer `{"status":"ok"}`.

> **Limites de l'offre gratuite Render**
> - Le service web s'endort après 15 minutes sans trafic. La première requête qui suit prend alors environ 1 minute : le dashboard affiche « Le serveur gratuit se réveille… » et l'application mobile met ses envois en file d'attente puis réessaie.
> - La base PostgreSQL Free **expire 30 jours après sa création**. Passez-la sur une offre payante ou recréez-la avant cette échéance (exportez les données avec `pg_dump`).

> **Base sans expiration (recommandé)** : créez une base gratuite sur https://neon.tech (région Frankfurt), puis remplacez `DATABASE_URL` du service Render par l'adresse Neon **directe** (sans `-pooler`, avec `?sslmode=require`). Le script `deploy/deploy.sh` fait tout automatiquement : `GITHUB_TOKEN=… RENDER_API_KEY=… EXTERNAL_DATABASE_URL=… bash deploy/deploy.sh`.

### 1.2 Dashboard sur GitHub Pages

**Option A — GitHub Actions (recommandée)**

1. Dans *Settings → Pages*, choisissez *Source = GitHub Actions*.
2. Dans *Settings → Secrets and variables → Actions → Variables*, créez `VITE_API_URL` = `https://schoolap-erp-api.onrender.com`.
3. Faites un push sur `main`. Le workflow `.github/workflows/deploy-dashboard.yml` compile le dashboard avec `VITE_BASE=/<nom-du-dépôt>/` et le publie via `actions/deploy-pages`.

**Option B — script `npm run deploy` (branche `gh-pages`)**

```bash
cd dashboard
echo "VITE_API_URL=https://schoolap-erp-api.onrender.com" > .env.production.local
echo "VITE_BASE=/schoolap-erp/" >> .env.production.local   # nom de votre dépôt
npm ci
npm run deploy        # predeploy → vite build, puis gh-pages -d dist
```

Choisissez ensuite *Settings → Pages → Branch = gh-pages*.

La route de base est réglée dans `dashboard/vite.config.js` : `base` vaut `VITE_BASE` en production (`/schoolap-erp/` par défaut) et `/` en développement.

Le tableau de bord n'a **aucun mode visiteur ou démonstration** : il faut un compte du personnel administratif (voir la section 2bis).

### 1.3 Espace Enseignant pour iPhone (application web installable, gratuite)

**Lien à ouvrir dans Safari sur l'iPhone :** https://daniel2003-bot-dotcom.github.io/schoolap-erp/enseignant/

1. Ouvrez le lien dans **Safari**, puis connectez-vous (téléphone + mot de passe du compte Enseignant).
2. Touchez **Partager** (carré avec une flèche vers le haut), puis **« Sur l'écran d'accueil »** et **Ajouter**.
3. L'icône **« Enseignant »** s'ouvre en plein écran, comme une application.

Fonctionnement identique à l'application Android :
- appel (Présent / Absent, « marquer les restants présents ») ;
- cotes par matière, période et évaluation ;
- **mode hors ligne** : listes et saisies stockées sur le téléphone (IndexedDB), application disponible sans réseau grâce au service worker ;
- envoi automatique des saisies dès le retour du réseau, avec SMS d'absence aux tuteurs.

Le même lien fonctionne aussi sur Android (bouton « Installer ») et sur ordinateur.

Une application iOS « native » sur l'App Store ou TestFlight demande un compte Apple Developer payant (99 $ par an) et une compilation sur Mac. L'application web installable évite ce coût.

### 1.4 Application mobile Android (APK)

**Téléchargement direct (sur le téléphone Android) :** https://github.com/DANIEL2003-Bot-dotcom/schoolap-erp/releases/latest/download/schoolap-enseignant.apk

L'APK est compilé, testé, signé et publié automatiquement par GitHub Actions (workflow « Application enseignant (APK) ») à chaque modification du dossier `mobile/`. Il est déjà relié à l'API de production. La signature est toujours la même (clé stockée dans les secrets chiffrés du dépôt), donc les mises à jour s'installent par-dessus l'ancienne version.

Compilation manuelle :

```bash
cd mobile
flutter pub get
flutter build apk --release --dart-define=API_URL=https://schoolap-erp-api.onrender.com
# → build/app/outputs/flutter-apk/app-release.apk
```

L'URL du serveur reste modifiable depuis l'écran de connexion (*Paramètres du serveur*).

---

## 2. Comptes initiaux (seed « Institut Mwanga », Goma, code EPST NK1-GOMA-0427)

| Rôle | Téléphone | Mot de passe par défaut | Classes |
|---|---|---|---|
| Directeur — bureau Direction | `+243 990 000 001` | `Directeur@2026` | toutes (dashboard) |
| Enseignant — Salle des professeurs | `+243 970 000 002` | `Enseignant@2026` | 5e Primaire A, 4e Humanités Scientifique |
| Enseignante — Salle des professeurs | `+243 810 000 003` | `Enseignant@2026` | 3e Humanités Commerciale |

Contenu du seed :
- 42 élèves ;
- des frais d'inscription et de 1er/2e trimestre, dont 16 insolvables ;
- 82 transactions Mobile Money historiques ;
- 5 jours d'appel avec les SMS correspondants.

L'appel du jour du **5e Primaire A est volontairement laissé vide** pour pouvoir faire l'appel en direct depuis l'application mobile.

---

## 2bis. Structure administrative EPST : bureaux, rôles et droits

Chaque établissement dispose automatiquement de **5 bureaux** (créés par la migration `20261025000000_structure_epst` pour les écoles existantes, puis par le seed et l'API pour les nouvelles) :

| Bureau | Rôle(s) rattaché(s) par défaut |
|---|---|
| Direction | Directeur, Administrateur |
| Études / Préfecture | Préfet des études, Directeur des études (D.E.) |
| Discipline | Directeur de discipline (D.D.) |
| Comptabilité / Caisse | Comptable |
| Salle des professeurs | Enseignants |

Le bureau proposé suit le rôle, mais il reste modifiable dans le formulaire du compte (par exemple un enseignant détaché à la Discipline).

| Droit | Admin | Préfet | Directeur | D.E. | D.D. | Comptable | Enseignant |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Tableau de bord et listes (consultation) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Comptes du personnel | ✓ | ✓ | ✓ | — | — | — | — |
| Classes, titulaires, matières | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Inscriptions et import d'élèves | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| Frais, remises, relances SMS, encaissement Mobile Money | ✓ | ✓ | ✓ | — | — | ✓ | — |
| Appel (application mobile) | ✓ | ✓ | ✓ | ✓ | ✓ | — | ses classes |
| Saisie des cotes (application mobile) | ✓ | ✓ | ✓ | ✓ | — | — | ses classes |

- Depuis **Modifier**, on peut changer le nom, le **numéro de téléphone (identifiant)**, le rôle, le bureau et le mot de passe d'un compte. Un numéro déjà utilisé est refusé.
- Seul un **Administrateur** peut créer ou modifier un compte Administrateur. Personne ne peut changer son propre rôle ni désactiver son propre compte.
- Les comptes sont créés par l'administration (**Classes & personnel → + Nouveau compte**). Le mot de passe initial doit compter **8 caractères minimum avec au moins une lettre et un chiffre**. Il est stocké uniquement sous forme de **hachage bcrypt (coût 12, sel aléatoire)** et n'est jamais renvoyé par l'API.
- Le **tableau de bord est entièrement verrouillé** : il n'existe aucun mode visiteur ou démonstration. Sans jeton valide, seule la page de connexion s'affiche. Au démarrage, la session est vérifiée auprès de l'API (`/api/auth/me`) avant tout affichage. Un jeton expiré, falsifié ou appartenant à un compte désactivé ramène immédiatement à la connexion.
- Les routes d'encaissement Mobile Money exigent un jeton et le droit « Frais ». Seul le webhook de l'opérateur reste public, protégé par sa signature HMAC.
- Sur la page de connexion comme dans le formulaire de compte, l'**icône œil** affiche ou masque le mot de passe saisi.

---

## 3. Développement local

Prérequis : Node ≥ 20, PostgreSQL ≥ 14 (ou Docker) et Flutter stable récent (Dart ≥ 3.13).

> Pas à pas détaillé pour Windows, Linux et macOS, avec dépannage : voir **[GUIDE-DEMARRAGE.md](GUIDE-DEMARRAGE.md)**.

```bash
# Base de données : soit Docker…
docker compose up -d            # crée schoolap + schoolap_test (utilisateur schoolap / schoolap)
# …soit un PostgreSQL installé
createuser -P schoolap          # mot de passe : schoolap
createdb -O schoolap schoolap
createdb -O schoolap schoolap_test

# API
cd backend
cp .env.example .env
npm install                     # lance aussi prisma generate
npm run db:setup:local          # migrations + données initiales (Institut Mwanga)
npm run dev                     # http://localhost:4000

# Tests (base schoolap_test : vidée puis réensemencée avant chaque test)
DATABASE_URL=postgresql://schoolap:schoolap@localhost:5432/schoolap_test npx prisma migrate deploy
npm test                        # 34 tests (dont 13 pour la gestion administrative)

# Dashboard (autre terminal)
cd dashboard
npm install
npm run dev                     # http://localhost:5174 (proxy /api → :4000, aucun réglage CORS)

# Mobile
cd mobile
flutter test                    # 15 tests (file d'attente, sqflite FFI, widgets, captures)
flutter run --dart-define=API_URL=http://10.0.2.2:4000   # émulateur Android
```

---

## 4. Référence de l'API

Toutes les erreurs ont la forme `{"success": false, "error": {"code", "message", "details?"}}`.

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| GET | `/api/health` | public | Santé (avec ping de la base) |
| POST | `/api/auth/login` | public (10 / 15 min / IP) | `{phone, password}` → JWT |
| GET | `/api/auth/me` | JWT | Profil : rôle, bureau, droits, école (vérification de session du dashboard) |
| GET | `/api/teacher/bootstrap` | droit « Appel » | Classes, élèves, matières, appel du jour et cotes, pour le mode hors ligne |
| POST | `/api/attendance/sync` | droit « Appel » | Lot de présences (500 max) |
| POST | `/api/grades/sync` | droit « Cotes » | Lot de cotes |
| GET | `/api/dashboard/summary?date=AAAA-MM-JJ` | droit « Consultation » | KPI, absents, insolvables |
| POST | `/api/fees/:feeId/remind` | droit « Frais » | Relance SMS (1 par 24 h et par frais, sinon 429) |
| POST | `/api/payments/mobile-money` | JWT + droit « Frais » (10 / min / IP) | Lance un paiement → 202 + `transactionId` |
| POST | `/api/payments/mobile-money/webhook` | signature HMAC | Confirmation de l'opérateur |
| GET | `/api/payments/mobile-money/:transactionId` | JWT + droit « Frais » | Suivi du paiement |
| GET | `/api/admin/overview` | droit « Consultation » | Classes (titulaire, effectif), bureaux, personnel, rôles attribuables, matières |
| POST / PATCH / DELETE | `/api/admin/classes[/:id]` | droit « Classes » | Classes ; nom unique (409) ; suppression seulement si aucun élève |
| POST / PATCH | `/api/admin/users[/:id]` | droit « Personnel » | Comptes Préfet / Directeur / D.E. / D.D. / Comptable / Enseignant, bureau, mot de passe (bcrypt 12), activation |
| POST / PATCH | `/api/admin/subjects[/:id]` | droit « Classes » | Matières et note maximale par défaut |
| GET | `/api/admin/students?classId=&q=&status=&page=` | droit « Consultation » | Liste paginée + reste à payer |
| GET | `/api/admin/students/:id` | droit « Consultation » | Fiche : frais, paiements, assiduité |
| POST / PATCH | `/api/admin/students[/:id]` | droit « Inscriptions » | Inscription (matricule auto, frais de la classe), transfert, désinscription |
| POST | `/api/admin/students/import` | droit « Inscriptions » | Import CSV `{classId, csv, dryRun}` (1 000 lignes max, tout ou rien) |
| GET | `/api/admin/fees/summary` | droit « Consultation » | Synthèse par frais (attendu, encaissé, statuts) |
| POST | `/api/admin/fees/bulk` | droit « Frais » | Frais pour une ou plusieurs classes (idempotent) |
| PATCH | `/api/admin/fees/:id` | droit « Frais » | Remise / report ; montant dû ≥ déjà payé ; statut recalculé |

### Synchronisation des présences

Requête :

```json
POST /api/attendance/sync
{ "records": [ { "id": "uuid-généré-sur-le-téléphone", "studentId": "…", "date": "2026-10-24",
                 "isPresent": false, "clientUpdatedAt": "2026-10-24T06:12:00.000Z" } ] }
```

Fonctionnement :
- Les conflits suivent la règle de la **dernière écriture gagnante**, selon `clientUpdatedAt`. Chaque résultat vaut `created`, `updated`, `unchanged` ou `stale`.
- Les requêtes sont **idempotentes** : un lot renvoyé après une coupure réseau ne crée ni doublon ni nouveau SMS.
- Pour chaque nouvel absent, le serveur simule l'envoi d'un SMS au tuteur. Le numéro est **toujours relu en base**, jamais pris dans la requête. Le message est affiché en détail dans la console et journalisé dans `sms_logs` :

```
╔════════════════════════════════════════════════════════════════
║ 📱 PASSERELLE SMS — ENVOI AUTOMATISÉ (SIMULATION)
╠════════════════════════════════════════════════════════════════
║ Type         : ALERTE D'ABSENCE
║ Destinataire : +243 89 103 9595 (Tuteur de KAVUGHO NZANZU Sarah)
║ Message      : Alerte École : Votre enfant KAVUGHO NZANZU Sarah a été marqué ABSENT ce 24/10/2026.
║ Statut       : ✅ ACCEPTÉ PAR L'OPÉRATEUR — ID SMS-74D3A843
╚════════════════════════════════════════════════════════════════
```

### Paiement Mobile Money (simulation complète)

1. `POST /api/payments/mobile-money` avec `{studentId, schoolFeeId, operator: "MPESA"|"ORANGE_MONEY"|"AIRTEL_MONEY", phone, amount}`. L'API contrôle :
   - la cohérence entre le préfixe du numéro et l'opérateur (M-Pesa 81/82/83, Orange 80/84/85/89, Airtel 97/98/99) ;
   - que le montant ne dépasse pas le reste à payer ;
   - que le frais n'est pas déjà soldé ;
   - qu'aucune demande n'est déjà en attente.
2. Après `OPERATOR_CALLBACK_DELAY_MS`, l'« opérateur » simulé appelle le **webhook signé** (`X-Signature: sha256=<HMAC du corps brut>`). Environ 10 % des paiements échouent (solde insuffisant, PIN incorrect…).
3. Le webhook est **idempotent**. En cas de succès, une transaction PostgreSQL :
   - passe la transaction en `SUCCESS` ;
   - incrémente `amount_paid` ;
   - recalcule le statut (`SOLDE`, `EN_COURS` ou `INSOLVABLE`).

   Un reçu SMS est ensuite envoyé au tuteur.

Pour brancher un vrai agrégateur, mettez `SIMULATE_OPERATOR_CALLBACK=false` et faites pointer son callback vers `/api/payments/mobile-money/webhook` avec le même secret HMAC.

### Gestion administrative (onglets Élèves, Classes & personnel, Frais)

- **Inscription** : le matricule est attribué automatiquement si on le laisse vide (`2026-0427-00001`, construit à partir de l'année et du code EPST). L'élève reçoit les frais déjà portés par sa classe pour l'année en cours (option décochable).
- **Import CSV** (export Excel « CSV UTF-8 », séparateur `;` ou `,`) :

  ```
  nom;postnom;prenom;sexe;telephone_tuteur;nom_tuteur;matricule
  Mumbere;Kakule;Fiston;M;0971112233;Papa Mumbere;
  ```

  « Vérifier le fichier » fait une simulation (`dryRun`) qui liste les erreurs ligne par ligne : téléphone invalide, sexe inconnu, matricule en double ou déjà pris. L'import réel est transactionnel : tout le fichier passe, ou rien n'est écrit.
- **Désinscription** plutôt que suppression : l'élève disparaît des listes d'appel et des statistiques, mais son historique (présences, cotes, paiements) est conservé.
- **Personnel** : choisissez le rôle (Préfet, Directeur, D.E., D.D., Comptable, Enseignant) et le bureau. Un compte enseignant créé ici peut se connecter immédiatement sur l'application mobile. Il retrouve ses classes après « Recharger ». Désactiver un enseignant bloque sa connexion et laisse ses classes « sans titulaire ».
- **Frais** : la création groupée ne facture jamais deux fois le même libellé à un élève. Une remise ou un report d'échéance recalcule le statut Soldé / En cours / Insolvable.
- Les boutons d'action n'apparaissent que si le rôle connecté en a le droit (voir 2bis). L'API applique les mêmes règles.

---

## 5. Application mobile : modèle hors ligne d'abord

- **sqflite** stocke ces tables : `classes`, `students`, `subjects`, `attendance`, `grades`, `outbox` et `kv`.
- Chaque interrupteur ou chaque cote est écrit **d'abord en local** (`is_synced = 0`, nuage orange) et ajouté à la table `outbox`. Il n'y a qu'une seule entrée par enregistrement : seule la dernière version est envoyée.
- Le `SyncEngine` envoie la file par lots de 100 :
  - quand le réseau revient (`connectivity_plus`) ;
  - 0,8 s après une saisie ;
  - toutes les minutes ;
  - à la demande de l'utilisateur.
- Gestion des réponses :
  - **Accusé par enregistrement** : la ligne passe en coche verte seulement si elle n'a pas été modifiée pendant l'envoi.
  - **Rejet de validation** : une icône rouge et le message du serveur s'affichent, et l'élément sort de la file.
  - **Réseau, 429 ou 5xx** : nouvel essai avec un délai exponentiel (5 s → 15 min, avec gigue).
  - **401** : les envois sont suspendus, les données sont conservées et l'application demande de se reconnecter.
- La saisie des cotes se fait au clavier numérique. « Suivant » enregistre la cote et passe à l'élève suivant. Une cote comprise entre 0 et le maximum est exigée ; la virgule décimale est acceptée.

---

## 6. Sécurité

Côté API :
- Helmet ;
- liste blanche CORS (les applications mobiles, sans en-tête `Origin`, sont acceptées) ;
- limites de débit ;
- validation Zod de toutes les entrées ;
- JWT, avec rechargement de l'utilisateur à chaque requête : un compte désactivé perd l'accès immédiatement ;
- bcrypt, avec un hash factice pour obtenir un temps de réponse constant ;
- webhooks signés en HMAC-SHA256 et comparés en temps constant ;
- montants en `Decimal(12,2)`.

Côté dashboard : le JWT est stocké en `sessionStorage`.

Côté mobile : la base locale est effacée à la déconnexion ou en cas de changement de compte.
