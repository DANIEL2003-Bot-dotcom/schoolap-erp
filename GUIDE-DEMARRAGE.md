# Guide pas à pas : exécuter puis déployer l'ERP scolaire

Ce guide part de zéro. Il est écrit pour **Windows** ; les commandes Linux/macOS sont données quand elles diffèrent.

Il comporte trois parties :

| Partie | Ce que vous obtenez | Durée |
|---|---|---|
| **A. Exécuter sur votre ordinateur** | API + tableau de bord + application mobile en local | 30 à 60 min |
| **B. Déployer gratuitement sur Internet** | API sur Render, tableau de bord sur GitHub Pages, APK Android | 30 min |
| **C. Dépannage** | Solutions aux erreurs les plus fréquentes | — |

> 💡 **Connexion Internet** : prévoyez environ 300 Mo à télécharger pour la partie A (Node, PostgreSQL, dépendances). Ajoutez 2 à 3 Go si vous installez Flutter et Android Studio pour l'application mobile. Une connexion Wi-Fi stable est conseillée.

---

## 0. Préparer son poste (une seule fois)

### 0.1 Logiciels à installer

| Logiciel | Pourquoi | Où le trouver |
|---|---|---|
| **Node.js 20 LTS** (ou 22) | Faire tourner l'API et le tableau de bord | https://nodejs.org → bouton « LTS » |
| **Git** | Envoyer le code sur GitHub | https://git-scm.com/download/win |
| **PostgreSQL 17** *ou* **Docker Desktop** | La base de données locale | https://www.postgresql.org/download/windows/ · https://www.docker.com/products/docker-desktop/ |
| VS Code (conseillé) | Ouvrir et modifier le code | https://code.visualstudio.com |
| Flutter + Android Studio (*mobile uniquement*) | Compiler l'application enseignant | https://docs.flutter.dev/get-started/install/windows |

Vérifiez les installations. Ouvrez **PowerShell** (touche Windows, puis tapez « PowerShell ») et lancez :

```powershell
node -v     # doit afficher v20.x ou plus
npm -v
git --version
```

### 0.2 Comptes gratuits (pour la partie B)

- **GitHub** : https://github.com/signup
- **Render** : https://render.com, puis « Get Started » → **« Sign in with GitHub »**. C'est le plus simple, car Render verra directement vos dépôts.

### 0.3 Récupérer le code

1. Téléchargez **`schoolap-erp.zip`** depuis l'espace de travail.
2. Faites un clic droit → « Extraire tout… », par exemple vers `C:\projets\schoolap-erp`.
3. Ouvrez un terminal dans ce dossier :

   ```powershell
   cd C:\projets\schoolap-erp
   ```

---

## Partie A — Exécuter l'application sur votre ordinateur

L'application se compose de trois programmes qui tournent en même temps :

```
 [ PostgreSQL :5432 ]  ←  [ API Node :4000 ]  ←  [ Tableau de bord :5174 ]
                                  ↑
                        [ Application mobile Flutter ]
```

### A1. La base de données

Choisissez **une seule** des deux options.

#### Option 1 — PostgreSQL installé (sans Docker)

1. Lancez l'installateur PostgreSQL 17 et gardez les options par défaut (port **5432**). **Notez le mot de passe** que vous donnez à l'utilisateur `postgres`.
2. Dans le menu Démarrer, ouvrez **« SQL Shell (psql) »**. Appuyez sur Entrée à chaque question, puis tapez le mot de passe `postgres` noté plus haut.
3. Copiez-collez ces trois lignes, puis appuyez sur Entrée :

   ```sql
   CREATE USER schoolap WITH PASSWORD 'schoolap' CREATEDB;
   CREATE DATABASE schoolap OWNER schoolap;
   CREATE DATABASE schoolap_test OWNER schoolap;
   ```

   Chaque ligne doit afficher `CREATE ROLE` ou `CREATE DATABASE`. Tapez `\q` pour quitter.

*Sous Linux* : `sudo -u postgres psql`, puis les mêmes trois lignes.

#### Option 2 — Docker (une commande)

Démarrez Docker Desktop, puis, dans le dossier `schoolap-erp` :

```powershell
docker compose up -d
```

Cette commande crée les bases `schoolap` et `schoolap_test` (utilisateur `schoolap`, mot de passe `schoolap`). Pour l'arrêter : `docker compose stop`.

### A2. L'API (backend)

Dans le terminal, depuis le dossier `schoolap-erp` :

```powershell
cd backend
copy .env.example .env        # Linux/macOS : cp .env.example .env
npm install                   # 2 à 5 minutes la première fois
npm run db:setup:local        # crée les tables, les 5 bureaux et les données initiales
npm run dev
```

Le terminal doit afficher `API ERP scolaire démarrée … "port":4000`. **Laissez cette fenêtre ouverte.**

Vérification : ouvrez http://localhost:4000/api/health dans le navigateur. Il doit afficher `{"status":"ok", …}`.

> Si vous avez choisi un autre mot de passe ou un autre port pour PostgreSQL, modifiez la ligne `DATABASE_URL` du fichier `backend\.env` :
> `postgresql://UTILISATEUR:MOT_DE_PASSE@localhost:5432/schoolap`

### A3. Le tableau de bord du Directeur

Ouvrez un **deuxième** terminal :

```powershell
cd C:\projets\schoolap-erp\dashboard
npm install
npm run dev
```

Ouvrez **http://localhost:5174** et connectez-vous :

| Rôle | Téléphone | Mot de passe |
|---|---|---|
| Directeur | `0990000001` | `Directeur@2026` |

Vous accédez au tableau de bord (taux de présence, absents, recouvrement) et aux onglets **Élèves**, **Classes & personnel** et **Frais**. Rien n'est à configurer : le serveur de développement relaie automatiquement `/api` vers `localhost:4000`.

### A4. L'application mobile des enseignants (facultatif)

Prérequis : Flutter installé et `flutter doctor` sans erreur bloquante (au minimum les lignes Flutter et Android toolchain).

```powershell
cd C:\projets\schoolap-erp\mobile
flutter pub get
```

**Sur l'émulateur Android** (Android Studio → Device Manager → ▶) :

```powershell
flutter run --dart-define=API_URL=http://10.0.2.2:4000
```

`10.0.2.2` est l'adresse de votre PC vue depuis l'émulateur.

**Sur un vrai téléphone** (branché en USB, avec le « Débogage USB » activé dans les options développeur) :

1. Le téléphone et le PC doivent être sur **le même Wi-Fi**.
2. Trouvez l'adresse IP du PC : tapez `ipconfig` et repérez la ligne « Adresse IPv4 », par exemple `192.168.1.20`.
3. Lancez :

   ```powershell
   flutter run --dart-define=API_URL=http://192.168.1.20:4000
   ```

4. Si Windows demande d'autoriser Node.js dans le pare-feu, cochez **« Réseaux privés »**.

Connectez-vous avec un compte enseignant :

| Enseignant | Téléphone | Mot de passe | Classes |
|---|---|---|---|
| Kambale Jean | `0970000002` | `Enseignant@2026` | 5e Primaire A, 4e Humanités Scientifique |
| Kavira Esther | `0810000003` | `Enseignant@2026` | 3e Humanités Commerciale |

L'adresse du serveur peut aussi être changée plus tard sur l'écran de connexion (**Paramètres du serveur**).

### A5. Scénario de prise en main complet (5 minutes)

1. **Mobile** : connectez-vous avec Kambale Jean et ouvrez **5e Primaire A**. L'appel du jour est volontairement vide.
2. Mettez deux élèves en **Absent** (interrupteur rouge), puis enregistrez.
   - Sans réseau (mode avion), un **nuage orange** apparaît : l'appel est stocké dans le téléphone.
   - Réseau revenu, une **coche verte** confirme la synchronisation.
3. **Terminal de l'API** : les SMS simulés s'affichent, par exemple `Alerte École : Votre enfant … a été marqué ABSENT ce 24/10/2026.`
4. **Tableau de bord** : cliquez sur « Actualiser ». Le taux de présence change et les absents portent le badge **« SMS envoyé »**.
5. **Comptabilité** : dans « Insolvables », cliquez sur **« Encaisser »**, choisissez M-Pesa, Orange ou Airtel, puis validez. Au bout de quelques secondes, la confirmation simulée de l'opérateur met à jour le solde.
6. **Gestion** : onglet **Élèves**, puis **« + Inscrire un élève »** ou **« Importer CSV »**. Un modèle de fichier est téléchargeable dans la fenêtre d'import.

### A6. Lancer les tests (facultatif)

```powershell
cd backend
# Une seule fois : créer les tables de la base de test
$env:DATABASE_URL="postgresql://schoolap:schoolap@localhost:5432/schoolap_test"; npx prisma migrate deploy
npm test                       # 34 tests
cd ..\mobile
flutter test                   # 15 tests
```

*Linux/macOS* : `DATABASE_URL=postgresql://schoolap:schoolap@localhost:5432/schoolap_test npx prisma migrate deploy`

---

## Partie B — Déployer gratuitement sur Internet

À la fin de cette partie, vous aurez :

```
 https://VOTRE-COMPTE.github.io/schoolap-erp/      ← tableau de bord (GitHub Pages)
 https://schoolap-erp-api.onrender.com             ← API + base PostgreSQL (Render)
 app-release.apk                                   ← application à partager aux enseignants
```

### B1. Envoyer le code sur GitHub

1. Sur https://github.com/new, créez un dépôt nommé **`schoolap-erp`**.
   - Choisissez **Public** : GitHub Pages est gratuit uniquement pour les dépôts publics.
   - **Ne cochez rien** (ni README, ni .gitignore, ni licence).
2. Dans un terminal, depuis le dossier `schoolap-erp` :

   ```powershell
   git config --global user.name "Votre Nom"
   git config --global user.email "vous@exemple.com"

   git init
   git add .
   git commit -m "ERP scolaire RDC - première version"
   git branch -M main
   git remote add origin https://github.com/VOTRE-COMPTE/schoolap-erp.git
   git push -u origin main
   ```

3. Au premier `git push`, une fenêtre de connexion GitHub s'ouvre (Git Credential Manager). Autorisez-la.

> 🔒 Le fichier `.gitignore` empêche l'envoi de `backend/.env` (vos secrets locaux), de `node_modules` et des dossiers de compilation. Vérifiez sur GitHub que `backend/.env` **n'apparaît pas**.

### B2. Déployer l'API et la base sur Render (Blueprint)

1. Sur https://dashboard.render.com, cliquez sur **New +** → **Blueprint**.
2. Connectez votre compte GitHub si on vous le demande, puis choisissez le dépôt **`schoolap-erp`**.
3. Render lit `render.yaml` et annonce la création de **`schoolap-erp-db`** (PostgreSQL Free) et **`schoolap-erp-api`** (Web Service Free).
4. Remplissez les trois valeurs demandées :

   | Variable | Valeur à saisir |
   |---|---|
   | `CORS_ORIGINS` | `https://votre-compte.github.io` en **minuscules**, **sans** `/schoolap-erp` et **sans** `/` final |
   | `SEED_DIRECTOR_PASSWORD` | Un mot de passe solide pour le compte Directeur |
   | `SEED_TEACHER_PASSWORD` | Un mot de passe pour les comptes enseignants initiaux |

5. Cliquez sur **Apply** (ou **Deploy Blueprint**). Le premier déploiement prend 5 à 10 minutes. Suivez-le dans *schoolap-erp-api → Logs* : vous devez voir les migrations, le seed, puis `API ERP scolaire démarrée`.
6. **Copiez l'URL du service**, affichée en haut de la page *schoolap-erp-api*. C'est normalement `https://schoolap-erp-api.onrender.com`, mais Render ajoute un suffixe si ce nom est déjà pris.
7. Vérifiez en ouvrant `https://VOTRE-URL-RENDER/api/health` : la page doit afficher `"status":"ok"`.

`JWT_SECRET` et `WEBHOOK_SECRET` sont générés automatiquement par Render : vous n'avez rien à faire.

### B3. Publier le tableau de bord sur GitHub Pages

1. Sur GitHub, ouvrez votre dépôt → **Settings** → **Pages**, puis, dans *Build and deployment*, choisissez **Source = GitHub Actions**.
2. Toujours dans **Settings**, allez dans **Secrets and variables** → **Actions** → onglet **Variables** → **New repository variable** :
   - Name : `VITE_API_URL`
   - Value : l'URL Render copiée en B2, **sans `/` final** (ex. `https://schoolap-erp-api.onrender.com`).
3. Ouvrez l'onglet **Actions** → **« Déployer le tableau de bord (GitHub Pages) »** → **Run workflow** → **Run workflow**.
4. Après 1 à 2 minutes (coche verte), le tableau de bord est en ligne sur **`https://votre-compte.github.io/schoolap-erp/`**.

Connectez-vous avec `0990000001` et le mot de passe `SEED_DIRECTOR_PASSWORD` choisi en B2.

> Le chemin `/schoolap-erp/` est réglé automatiquement d'après le nom du dépôt (`VITE_BASE`). Si vous renommez le dépôt, mettez à jour `CORS_ORIGINS` seulement si votre nom de compte change.

**Alternative sans GitHub Actions** (script `npm run deploy`) :

```powershell
cd dashboard
"VITE_API_URL=https://VOTRE-URL-RENDER" | Out-File -Encoding utf8 .env.production.local
"VITE_BASE=/schoolap-erp/" | Add-Content .env.production.local
npm run deploy
```

Choisissez ensuite *Settings → Pages → Source = Deploy from a branch → `gh-pages`*.

### B4. Construire l'APK pour les enseignants

```powershell
cd mobile
flutter build apk --release --dart-define=API_URL=https://VOTRE-URL-RENDER
```

Le fichier se trouve dans `mobile\build\app\outputs\flutter-apk\app-release.apk` (environ 20 Mo). Partagez-le par WhatsApp, clé USB ou Google Drive. Sur le téléphone, autorisez « Installer des applications inconnues » pour l'application qui ouvre le fichier.

> Pour une publication sur le Play Store, il faut une clé de signature personnelle (voir https://docs.flutter.dev/deployment/android). Pour une diffusion directe dans l'école, l'APK ci-dessus suffit.

### B3 bis. Tableau de bord sur le téléphone de la Direction

Ouvrez le lien du tableau de bord sur le téléphone, puis :
- **Android** : touchez **Installer** ;
- **iPhone** : dans Safari, **Partager → « Sur l'écran d'accueil »**.

L'icône **« Direction »** apparaît. Elle s'ouvre en plein écran, même sans réseau, avec les derniers chiffres consultés.

### B4 bis. Enseignants équipés d'un iPhone

Envoyez-leur le lien **https://daniel2003-bot-dotcom.github.io/schoolap-erp/enseignant/**. Ils l'ouvrent dans Safari, touchent **Partager → « Sur l'écran d'accueil »**, puis se connectent avec leur compte Enseignant. L'appel et les cotes fonctionnent aussi sans réseau. Le lien sert également sur Android et sur ordinateur.

### B5. Après la mise en ligne : à faire tout de suite

1. **Changer les mots de passe** : connectez-vous comme Directeur, puis **Classes & personnel → Personnel → Modifier**. Donnez un nouveau mot de passe à chaque enseignant.
2. **Créer vos vrais comptes, classes et élèves** dans les onglets **Classes & personnel** et **Élèves**. L'import CSV depuis Excel se fait via « Enregistrer sous → CSV UTF-8 ».
3. **Désactiver les comptes initiaux** dont vous n'avez pas besoin.
4. **Créer l'équipe administrative** (Préfet, D.E., D.D., Comptable) via **+ Nouveau compte**. Chaque rôle est rattaché automatiquement à son bureau (tableau des droits : README, section 2bis).

### B6. Mettre à jour l'application plus tard

Il suffit de pousser vos modifications :

```powershell
git add .
git commit -m "Description de la modification"
git push
```

Le pipeline GitHub Actions **CI** exécute les tests de l'API et le build du tableau de bord. **Seulement si tout est vert**, le job « deploy-api » demande à Render de déployer ce commit (secrets `RENDER_API_KEY` et `RENDER_SERVICE_ID`). Les migrations Prisma s'appliquent à Neon au démarrage, et Render ne bascule le trafic qu'une fois `/api/health` opérationnel : il n'y a aucune coupure. Une migration en échec laisse l'ancienne version en ligne. GitHub Actions republie le tableau de bord dès que le dossier `dashboard/` change. Pour l'application mobile, reconstruisez l'APK et redistribuez-le.

### B7. Limites de l'offre gratuite (à connaître)

| Limite | Conséquence | Parade |
|---|---|---|
| L'API Render **s'endort après 15 min** sans visite | La première requête prend environ 1 minute | Le tableau de bord affiche « Le serveur se réveille… ». L'application mobile garde les appels en file d'attente et réessaie : aucune donnée n'est perdue. |
| La base PostgreSQL Free **expire 30 jours** après sa création | Les données sont supprimées | Avant l'échéance : passez la base en offre payante (*Upgrade*), ou exportez-la (ci-dessous), recréez-la et réimportez. |
| 750 h d'exécution gratuite par mois et par compte | Suffisant pour un service | N'hébergez qu'une API gratuite par compte. |

**Sauvegarder la base Render** :

1. Dans *schoolap-erp-db → Info → Networking / Access Control*, ajoutez votre adresse IP (bouton « Add your IP »).
2. Copiez l'**External Database URL**.
3. Lancez :

   ```powershell
   pg_dump "URL_EXTERNE_COPIÉE" -Fc -f sauvegarde-ecole.dump
   # restauration dans une nouvelle base :
   pg_restore -d "NOUVELLE_URL_EXTERNE" --no-owner sauvegarde-ecole.dump
   ```

`pg_dump` et `pg_restore` sont fournis avec PostgreSQL : `C:\Program Files\PostgreSQL\17\bin`.

---

## Partie C — Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `npm : Impossible de charger le fichier … npm.ps1` (PowerShell) | Scripts bloqués par Windows | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, puis répondez « O » ; ou utilisez l'« Invite de commandes » (cmd). |
| `P1001: Can't reach database server at localhost:5432` | PostgreSQL arrêté ou absent | Démarrez le service « postgresql-x64-17 » (services.msc) ou `docker compose up -d`. |
| `P1000: Authentication failed` | Mauvais mot de passe dans `DATABASE_URL` | Corrigez `backend\.env` ou refaites les commandes `CREATE USER` de l'étape A1. |
| `@prisma/client did not initialize yet` | Client Prisma non généré | `cd backend` puis `npx prisma generate`. |
| `EADDRINUSE: address already in use :::4000` | Une autre API tourne déjà | Fermez l'autre terminal ou changez `PORT=4001` dans `.env`. Pour le dashboard local, lancez alors `$env:API_PROXY_TARGET="http://localhost:4001"; npm run dev`. |
| Dashboard local : « Serveur injoignable » | L'API n'est pas démarrée | Vérifiez http://localhost:4000/api/health (étape A2). |
| Dashboard en ligne : page blanche ou erreur 404 sur les fichiers JS | Mauvais chemin de base | Le dépôt doit s'appeler comme le chemin de l'URL. Relancez le workflow après tout renommage. |
| Dashboard en ligne : « Serveur injoignable » ou erreur CORS (console F12) | `CORS_ORIGINS` ou `VITE_API_URL` incorrects | Sur Render, `CORS_ORIGINS=https://votre-compte.github.io` (sans chemin), puis *Manual Deploy*. Sur GitHub, vérifiez la variable `VITE_API_URL` et relancez le workflow. |
| Dashboard en ligne : très lent à la première connexion | Réveil de l'instance gratuite | Normal : patientez environ 1 minute. |
| Mobile : « Serveur injoignable » sur un vrai téléphone | Mauvaise IP, Wi-Fi différent ou pare-feu | Même Wi-Fi ; IP issue de `ipconfig` ; autoriser Node.js dans le pare-feu Windows (réseau privé). |
| Mobile : l'APK release n'arrive pas à se connecter | APK compilé avec une adresse `http://` locale | L'APK release doit pointer vers l'URL **https** Render (étape B4). |
| Render : déploiement en échec sur `prisma migrate deploy` | Base pas encore prête au premier lancement | *schoolap-erp-api → Manual Deploy → Deploy latest commit*. |
| Les SMS n'arrivent pas sur les téléphones | Normal : les SMS sont **simulés** | Ils s'affichent dans les logs de l'API (terminal ou *Logs* Render). Un vrai fournisseur (Africa's Talking, Twilio…) se branche dans `backend/src/services/sms.js`. |

---

**Besoin d'aide ?** Copiez le message d'erreur exact et l'étape où il apparaît (A2, B3…), et on le résout ensemble.
