#!/usr/bin/env bash
# =============================================================================
# Déploiement automatisé : GitHub (code + Pages) et Render (PostgreSQL + API)
#
# Variables requises :
#   GITHUB_TOKEN   jeton GitHub « classic » avec les scopes repo + workflow
#   RENDER_API_KEY clé API Render (Account Settings → API Keys)
# Variables facultatives :
#   REPO_NAME (schoolap-erp) · REGION (frankfurt)
#   SEED_DIRECTOR_PASSWORD / SEED_TEACHER_PASSWORD (générés si absents)
#   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL
#   EXTERNAL_DATABASE_URL  base PostgreSQL externe (Neon…) : aucune base Render n'est créée
#
# Usage : GITHUB_TOKEN=... RENDER_API_KEY=... bash deploy/deploy.sh
# Le script est ré-exécutable : les ressources déjà créées sont réutilisées.
# =============================================================================
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN manquant}"
: "${RENDER_API_KEY:?RENDER_API_KEY manquant}"
REPO_NAME="${REPO_NAME:-schoolap-erp}"
REGION="${REGION:-frankfurt}"
DB_NAME="${REPO_NAME}-db"
API_NAME="${REPO_NAME}-api"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/deploy/.state.json"   # ignoré par git : identifiants des ressources créées

gen_password() { python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(10))+'@'+str(secrets.randbelow(90)+10))"; }
SEED_DIRECTOR_PASSWORD="${SEED_DIRECTOR_PASSWORD:-$(gen_password)}"
SEED_TEACHER_PASSWORD="${SEED_TEACHER_PASSWORD:-$(gen_password)}"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔ %s\033[0m\n' "$*"; }
die() { printf '  \033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

gh() { # gh METHOD PATH [JSON]
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X "$1" "https://api.github.com$2" \
    -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" ${3:+-d "$3"})
  code="${out##*$'\n'}"; GH_BODY="${out%$'\n'*}"; GH_CODE="$code"
}
rd() { # rd METHOD PATH [JSON]
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X "$1" "https://api.render.com/v1$2" \
    -H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  code="${out##*$'\n'}"; RD_BODY="${out%$'\n'*}"; RD_CODE="$code"
}

# ----------------------------------------------------------------- 1. GitHub
log "GitHub : vérification du jeton"
gh GET /user
[ "$GH_CODE" = 200 ] || die "Jeton GitHub refusé ($GH_CODE) : $GH_BODY"
GH_LOGIN=$(echo "$GH_BODY" | json "d['login']")
GH_ID=$(echo "$GH_BODY" | json "d['id']")
GH_NAME=$(echo "$GH_BODY" | json "d.get('name') or d['login']")
OWNER_LC=$(echo "$GH_LOGIN" | tr '[:upper:]' '[:lower:]')
PAGES_ORIGIN="https://${OWNER_LC}.github.io"
PAGES_URL="${PAGES_ORIGIN}/${REPO_NAME}/"
ok "Compte : $GH_LOGIN"

log "GitHub : dépôt public $GH_LOGIN/$REPO_NAME"
gh GET "/repos/$GH_LOGIN/$REPO_NAME"
if [ "$GH_CODE" = 200 ]; then
  ok "Le dépôt existe déjà"
else
  gh POST /user/repos "{\"name\":\"$REPO_NAME\",\"description\":\"ERP scolaire RDC (inspiré de Schoolap) : API Express/Prisma, dashboard React, application Flutter hors ligne\",\"private\":false,\"has_wiki\":false}"
  [ "$GH_CODE" = 201 ] || die "Création du dépôt impossible ($GH_CODE) : $GH_BODY"
  ok "Dépôt créé"
fi

log "GitHub : envoi du code (branche main)"
cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { rm -rf .git; git init -q -b main; }
git config user.name "${GIT_AUTHOR_NAME:-$GH_NAME}"
git config user.email "${GIT_AUTHOR_EMAIL:-${GH_ID}+${GH_LOGIN}@users.noreply.github.com}"
git add -A
git diff --cached --quiet || git commit -qm "ERP scolaire RDC : déploiement"
git branch -M main
git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/${GH_LOGIN}/${REPO_NAME}.git" main 2>&1 | sed "s/${GITHUB_TOKEN}/***/g" || die "git push a échoué"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${GH_LOGIN}/${REPO_NAME}.git"
ok "Code poussé : https://github.com/$GH_LOGIN/$REPO_NAME"

# ----------------------------------------------------------------- 2. Render
log "Render : vérification de la clé"
rd GET "/owners?limit=20"
[ "$RD_CODE" = 200 ] || die "Clé Render refusée ($RD_CODE) : $RD_BODY"
OWNER_ID=$(echo "$RD_BODY" | json "d[0]['owner']['id']")
ok "Espace de travail : $(echo "$RD_BODY" | json "d[0]['owner']['name']") ($OWNER_ID)"

if [ -n "${EXTERNAL_DATABASE_URL:-}" ]; then
  log "Base de données externe (ex : Neon, sans expiration)"
  DATABASE_URL="$EXTERNAL_DATABASE_URL"
  DB_ID="externe"
  ok "DATABASE_URL fournie : $(echo "$DATABASE_URL" | sed -E 's#://([^:]+):[^@]+@#://\1:***@#')"
else
  log "Render : base PostgreSQL gratuite $DB_NAME"
  rd GET "/postgres?name=$DB_NAME&limit=20"
  DB_ID=$(echo "$RD_BODY" | json "next((x['postgres']['id'] for x in d if x['postgres']['name']=='$DB_NAME'), '')")
  if [ -z "$DB_ID" ]; then
    rd POST /postgres "{\"name\":\"$DB_NAME\",\"ownerId\":\"$OWNER_ID\",\"plan\":\"free\",\"region\":\"$REGION\",\"version\":\"17\",\"databaseName\":\"schoolap\",\"databaseUser\":\"schoolap\"}"
    [ "$RD_CODE" = 201 ] || die "Création de la base impossible ($RD_CODE) : $RD_BODY"
    DB_ID=$(echo "$RD_BODY" | json "d['id']")
    ok "Base créée ($DB_ID), expiration offre gratuite : $(echo "$RD_BODY" | json "d.get('expiresAt')")"
  else
    ok "Base existante réutilisée ($DB_ID)"
  fi
  printf '  attente de la disponibilité'
  for _ in $(seq 1 60); do
    rd GET "/postgres/$DB_ID"
    st=$(echo "$RD_BODY" | json "d.get('status','')")
    [ "$st" = available ] && break
    printf '.'; sleep 10
  done
  echo; [ "$st" = available ] || die "La base n'est pas disponible (statut : $st)"
  rd GET "/postgres/$DB_ID/connection-info"
  DATABASE_URL=$(echo "$RD_BODY" | json "d['internalConnectionString']")
  ok "Base disponible"
fi

log "Render : service web gratuit $API_NAME"
rd GET "/services?name=$API_NAME&limit=20"
SRV_ID=$(echo "$RD_BODY" | json "next((x['service']['id'] for x in d if x['service']['name']=='$API_NAME'), '')")
ENV_VARS=$(python3 - "$DATABASE_URL" "$PAGES_ORIGIN" "$SEED_DIRECTOR_PASSWORD" "$SEED_TEACHER_PASSWORD" <<'PY'
import json, sys
db, cors, dpw, tpw = sys.argv[1:5]
v = {
  "NODE_ENV": "production", "NODE_VERSION": "20.18.0", "DATABASE_URL": db,
  "JWT_EXPIRES_IN": "12h", "CORS_ORIGINS": cors, "SIMULATE_OPERATOR_CALLBACK": "true",
  "OPERATOR_CALLBACK_DELAY_MS": "4000", "SIMULATED_PAYMENT_FAILURE_RATE": "0.1",
  "SCHOOL_TIMEZONE": "Africa/Lubumbashi", "TRUST_PROXY": "1", "SMS_SENDER_ID": "ECOLE-RDC",
  "LOG_REQUESTS": "true", "SEED_DIRECTOR_PASSWORD": dpw, "SEED_TEACHER_PASSWORD": tpw,
}
out = [{"key": k, "value": x} for k, x in v.items()]
out += [{"key": "JWT_SECRET", "generateValue": True}, {"key": "WEBHOOK_SECRET", "generateValue": True}]
print(json.dumps(out))
PY
)
if [ -z "$SRV_ID" ]; then
  BODY=$(python3 - "$API_NAME" "$OWNER_ID" "$GH_LOGIN" "$REPO_NAME" "$REGION" "$ENV_VARS" <<'PY'
import json, sys
name, owner, login, repo, region, env = sys.argv[1:7]
print(json.dumps({
  "type": "web_service", "name": name, "ownerId": owner,
  "repo": f"https://github.com/{login}/{repo}", "branch": "main", "rootDir": "backend",
  "autoDeploy": "yes", "envVars": json.loads(env),
  "serviceDetails": {
    "runtime": "node", "plan": "free", "region": region, "healthCheckPath": "/api/health",
    "envSpecificDetails": {"buildCommand": "npm ci", "startCommand": "npm run render:start"},
  },
}))
PY
)
  rd POST /services "$BODY"
  [ "$RD_CODE" = 201 ] || die "Création du service impossible ($RD_CODE) : $RD_BODY"
  SRV_ID=$(echo "$RD_BODY" | json "d['service']['id']")
  ok "Service créé ($SRV_ID)"
else
  ok "Service existant ($SRV_ID) : mise à jour des variables et redéploiement"
  rd PUT "/services/$SRV_ID/env-vars" "$(echo "$ENV_VARS" | python3 -c "import json,sys; print(json.dumps([e for e in json.load(sys.stdin) if 'value' in e]))")"
  rd POST "/services/$SRV_ID/deploys" '{"clearCache":"do_not_clear"}'
fi
rd GET "/services/$SRV_ID"
API_URL=$(echo "$RD_BODY" | json "d['serviceDetails']['url']")
ok "URL de l'API : $API_URL"

# ------------------------------------------------------- 3. GitHub Pages
log "GitHub : variable VITE_API_URL et activation de Pages"
gh PATCH "/repos/$GH_LOGIN/$REPO_NAME/actions/variables/VITE_API_URL" "{\"name\":\"VITE_API_URL\",\"value\":\"$API_URL\"}"
if [ "$GH_CODE" != 204 ]; then
  gh POST "/repos/$GH_LOGIN/$REPO_NAME/actions/variables" "{\"name\":\"VITE_API_URL\",\"value\":\"$API_URL\"}"
  [ "$GH_CODE" = 201 ] || die "Variable impossible à créer ($GH_CODE) : $GH_BODY"
fi
ok "VITE_API_URL = $API_URL"
gh POST "/repos/$GH_LOGIN/$REPO_NAME/pages" '{"build_type":"workflow"}'
if [ "$GH_CODE" = 409 ] || [ "$GH_CODE" = 422 ]; then
  gh PUT "/repos/$GH_LOGIN/$REPO_NAME/pages" '{"build_type":"workflow"}'
fi
ok "Pages en mode GitHub Actions"
gh POST "/repos/$GH_LOGIN/$REPO_NAME/actions/workflows/deploy-dashboard.yml/dispatches" '{"ref":"main"}'
[ "$GH_CODE" = 204 ] || die "Lancement du workflow impossible ($GH_CODE) : $GH_BODY"
ok "Workflow de publication lancé"

# ------------------------------------------------------------- 4. Suivi
log "Render : suivi du premier déploiement (5 à 10 min)"
for _ in $(seq 1 90); do
  rd GET "/services/$SRV_ID/deploys?limit=1"
  dst=$(echo "$RD_BODY" | json "d[0]['deploy']['status']")
  case "$dst" in
    live) break ;;
    build_failed|update_failed|canceled|pre_deploy_failed|deactivated) die "Déploiement Render en échec : $dst (voir les logs sur dashboard.render.com)" ;;
  esac
  printf '  %s\r' "$dst"; sleep 10
done
[ "$dst" = live ] || die "Délai dépassé (statut : $dst)"
ok "API en ligne"
curl -sS --max-time 90 "$API_URL/api/health" && echo

python3 - "$STATE" <<PY
import json, sys
json.dump({"github": "$GH_LOGIN/$REPO_NAME", "renderOwner": "$OWNER_ID", "postgresId": "$DB_ID", "serviceId": "$SRV_ID",
           "apiUrl": "$API_URL", "dashboardUrl": "$PAGES_URL"}, open(sys.argv[1], "w"), indent=2)
PY

cat <<EOF

=============================================================
 ✅ Déploiement terminé
   Tableau de bord : $PAGES_URL   (1 à 2 min après le workflow)
   API             : $API_URL
   Code            : https://github.com/$GH_LOGIN/$REPO_NAME
   Directeur       : 0990000001 / $SEED_DIRECTOR_PASSWORD
   Enseignants     : 0970000002, 0810000003 / $SEED_TEACHER_PASSWORD
=============================================================
EOF
