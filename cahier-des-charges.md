# Cahier des charges — Budget Tracker (backend)

## 1. Vision

Outil personnel **mono-utilisateur** de suivi de dépenses, organisé en **périodes** nommables et indépendantes (typiquement un mois, mais l'utilisateur en décide).

- À tout instant, **exactement une période** est ouverte (sauf à l'amorçage, avant la toute première création).
- Créer une nouvelle période ferme automatiquement la précédente, **atomiquement** (pas de trou possible).
- Chaque période a un nom unique, un budget, et une liste de dépenses.
- Les **dépenses** ont un montant **signé** : négatif = sortie, positif = remboursement / rentrée. Aucune limitation, `0` autorisé. C'est au client d'interpréter.
- Le dépassement du budget ne déclenche rien : c'est de l'information, pas une règle.

L'API REST est l'élément central. Le frontend (à venir) n'est qu'un client parmi d'autres (curl, scripts, futur web).

## 2. Stack

| Composant | Choix | Version cible |
|---|---|---|
| Runtime | Node.js LTS | ≥ 24.15 |
| Modules | ESM uniquement (`"type": "module"`) | — |
| Framework HTTP | Express | ≥ 5.2.1 |
| DB | `node:sqlite` (module natif Node) | — |
| Hash mot de passe | `argon2` (Argon2id) | ≥ dernière stable |
| Validation API | `express-openapi-validator` | ≥ 5.5.0 |
| Logging | `console` natif | — |
| Config | flag natif `--env-file` | — |
| Watch dev | flag natif `--watch` | — |

**Dépendances runtime totales : 3** (`express`, `argon2`, `express-openapi-validator`).

`node:sqlite` est encore officiellement en *Release Candidate* (Stability 1.2) en Node 24, mais utilisable. À surveiller pour les évolutions d'API.

## 3. Structure du projet

```
.
├── package.json
├── openapi.yaml              ← source de vérité du contrat API
├── README.md
├── .gitignore                ← ignore data/, .env, node_modules
├── data/                     ← créé au setup, contient app.db
└── src/
    ├── index.js              ← entry : express + middleware + montage routes
    ├── db.js                 ← node:sqlite, schema, migrations, helpers
    ├── auth.js               ← middleware Basic Auth + cache TTL
    ├── setup.js              ← script d'install (npm run setup)
    ├── periods.js            ← handlers + logique métier "périodes"
    └── expenses.js           ← handlers + logique métier "dépenses"
```

## 4. Modèle de données

Toutes les tables sont créées en `STRICT` (typage strict SQLite).

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
) STRICT;

CREATE TABLE periods (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  budget    INTEGER NOT NULL,          -- centimes, ≥ 0
  opened_at TEXT NOT NULL,             -- ISO 8601 UTC
  closed_at TEXT                       -- NULL = période courante
) STRICT;

-- Invariant : au plus une période ouverte (closed_at IS NULL).
-- Astuce SQLite : index sur constante, restreint aux lignes ouvertes.
CREATE UNIQUE INDEX idx_periods_one_open
  ON periods((1)) WHERE closed_at IS NULL;

CREATE TABLE expenses (
  id         INTEGER PRIMARY KEY,
  period_id  INTEGER NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
  amount     INTEGER NOT NULL,         -- centimes signés (négatif = dépense)
  label      TEXT NOT NULL,
  date       TEXT NOT NULL,            -- YYYY-MM-DD
  created_at TEXT NOT NULL             -- ISO 8601 UTC
) STRICT;

CREATE INDEX idx_expenses_period ON expenses(period_id);
```

**Pourquoi un index unique sur `(1) WHERE closed_at IS NULL` ?** Parce que SQLite considère deux `NULL` comme distincts dans un index UNIQUE classique. Indexer une **constante** (`1`) limité aux lignes où `closed_at IS NULL` garantit qu'au plus une ligne peut satisfaire la condition. C'est l'idiome SQLite canonique pour "au plus une ligne respectant un prédicat".

À l'ouverture de la connexion :

```js
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA synchronous = NORMAL;");
```

## 5. Règles métier

### Périodes

- **`POST /periods`** est atomique : dans une seule transaction SQL,
  1. Si une période ouverte existe, on la ferme (`closed_at = now`).
  2. On insère la nouvelle période (`closed_at = NULL`).
  3. Si l'une des deux échoue, on rollback.
- Le `name` est unique sur l'ensemble des périodes (ouvertes ou closes) → 409 Conflict si déjà pris.
- `PATCH /periods/:id` accepte `name` et/ou `budget`, sur n'importe quelle période (ouverte ou close).
- Une période close **ne peut pas être réouverte** (par design : ça créerait deux périodes ouvertes).
- Une période **ne peut pas être supprimée** (pas d'endpoint DELETE). Si jamais besoin futur, ce sera à dessein.

### Dépenses

- Toute dépense appartient à exactement une période.
- **Création** : uniquement via `POST /periods/current/expenses`, qui ajoute la dépense à la période actuellement ouverte (404 si aucune). Pas d'endpoint pour créer directement dans une période arbitraire — la simplicité prime, et le cas "ajouter dans une période close" est marginal.
- **Rattachement à une période close après coup** : se fait exclusivement via `PATCH /expenses/:id` en modifiant `period_id`. Une dépense créée dans la période courante peut ensuite être déplacée vers n'importe quelle période (ouverte ou close). C'est le chemin canonique pour les corrections de saisie après clôture.
- `date` est optionnelle, défaut = date du jour (UTC). Peut être antidatée librement, et n'a aucun lien avec l'appartenance à une période (la période est déterminée par `period_id`, pas par la date).
- `amount` peut être négatif, positif, ou zéro. Aucune restriction métier.
- `DELETE /expenses/:id` supprime définitivement.

### Champs calculés sur une période

Renvoyés à chaque GET d'une période :

| Champ | Calcul |
|---|---|
| `status` | `closed_at IS NULL ? "open" : "closed"` |
| `spent` | `-SUM(amount)` sur les dépenses (positif si on a globalement dépensé) |
| `remaining` | `budget - spent` |
| `expense_count` | `COUNT(*)` des dépenses |

## 6. Authentification

- **Basic Auth** sur tous les endpoints `/api/v1/*`.
- Hash des mots de passe avec **Argon2id** (paquet `argon2`), paramètres par défaut du paquet (conformes recommandations OWASP 2024).
- Mono-utilisateur en pratique (table `users` ne contient qu'une ligne), mais le schéma autorise plusieurs lignes pour évolution future.
- Aucune session, aucun cookie, aucun JWT : Basic Auth pur.
- **Cache mémoire process des credentials validés**, pour éviter de payer la vérification Argon2 (~100 ms) à chaque requête :
  - `Map<authHeader, expiresAt>` (la clé est le header `Authorization` complet, déjà présent dans `req.headers`).
  - TTL **glissant** de 5 minutes : chaque hit refresh l'échéance.
  - Au cache miss : décodage Basic → lookup en DB → `argon2.verify` → si OK, insertion en cache.
  - **Seules les credentials valides entrent en cache.** Les tentatives invalides repaient Argon2 à chaque fois → rate limiting implicite contre le brute force.
  - Aucune invalidation explicite : un redémarrage du process (notamment après `npm run setup` pour changer le mot de passe) vide le cache.
  - Taille bornée en pratique (1 entrée en mono-user) → pas de logique d'éviction.
- Échec d'auth → **401** avec header `WWW-Authenticate: Basic realm="budget-tracker"`.

## 7. API REST

Contrat formel : `openapi.yaml` (OpenAPI 3.1).

Le spec est **exposé** sous `GET /openapi.yaml` (statique, non protégé par Basic Auth — c'est de la documentation publique).

Toutes les routes métier sont sous `/api/v1`.

### Validation runtime

`express-openapi-validator` est monté en amont de toutes les routes avec :

```js
const isDev = process.env.NODE_ENV !== 'production';

OpenApiValidator.middleware({
  apiSpec: './openapi.yaml',
  validateRequests:  true,
  validateResponses: isDev,
});
```

- **Requêtes entrantes : toujours validées** contre le spec (body, params, query, path). C'est la frontière hostile, donc validation systématique en prod comme en dev.
- **Réponses sortantes : validées uniquement en dev** (`NODE_ENV !== 'production'`). Évite le coût runtime en prod, et surtout évite qu'un schéma désynchronisé du handler casse l'API live en 500. Le drift est détecté en développement / CI avant déploiement.
- Toute déviation = erreur retournée automatiquement, sans atteindre / quitter le handler.

Conséquence : **le spec reste exécutable en dev (pas de drift possible)** ; en prod, l'API reste robuste face aux évolutions non synchrones du code, tout en gardant la validation des entrées.

### Codes HTTP utilisés

| Code | Cas |
|---|---|
| 200 | GET / PATCH OK |
| 201 | POST OK (ressource créée) |
| 204 | DELETE OK |
| 400 | Body / params malformés (rejeté par le validateur) |
| 401 | Auth manquante ou invalide |
| 404 | Ressource inconnue (ou pas de période courante) |
| 409 | Conflit (nom de période déjà pris) |
| 500 | Erreur serveur |

### Format des erreurs

Toutes les erreurs renvoient un JSON :

```json
{
  "error": "code_machine_readable",
  "message": "phrase humaine",
  "details": [ ... ]    // optionnel, contenu du validateur OpenAPI
}
```

Codes prévus : `validation_failed`, `unauthorized`, `not_found`, `conflict`, `internal_error`.

## 8. Installation

```bash
npm install
npm run setup
```

`npm run setup` exécute `node src/setup.js` et :

1. Crée `data/` si absent.
2. Ouvre `data/app.db`, applique le schéma (idempotent via `CREATE TABLE IF NOT EXISTS`).
3. Lit `username` et `password` au prompt (via `node:readline`, mot de passe masqué).
4. Hash avec Argon2id.
5. Insère la ligne dans `users`. Si une ligne existe déjà, demande `[y/N]` pour écraser.
6. Affiche un récap et quitte.

Pas de variable d'environnement pour les creds : la DB est la seule source de vérité.

## 9. Configuration

Tout via variables d'environnement, chargées au démarrage avec le flag natif `node --env-file=.env`.

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute HTTP |
| `DB_PATH` | `./data/app.db` | Chemin du fichier SQLite |
| `HOST` | `127.0.0.1` | Interface d'écoute |
| `NODE_ENV` | `development` | `production` désactive la validation des réponses |

Fichier `.env.example` fourni, `.env` git-ignoré.

## 10. Démarrage

```bash
# production
NODE_ENV=production node --env-file=.env src/index.js

# dev (auto-reload + validation des réponses activée)
node --env-file=.env --watch src/index.js
```

Scripts npm correspondants :

```json
{
  "scripts": {
    "start": "NODE_ENV=production node --env-file=.env src/index.js",
    "dev":   "node --env-file=.env --watch src/index.js",
    "setup": "node --env-file=.env src/setup.js"
  }
}
```

## 11. Notes d'implémentation

### Transactions avec `node:sqlite`

Pas de wrapper `db.transaction()` comme avec `better-sqlite3`. Approche manuelle :

```js
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

À utiliser pour `POST /periods` (close + insert) et pour toute opération composite à venir.

### Dates et horodatages

- Tous les `*_at` (timestamps) sont stockés en **ISO 8601 UTC** (`new Date().toISOString()`).
- Le champ `date` d'une dépense est au format `YYYY-MM-DD` (chaîne, pas de fuseau).
- Aucun fuseau horaire n'est traité côté serveur : c'est le client qui choisit son affichage.

### Convention de réponse

Les endpoints qui retournent une période ou une dépense retournent **toujours l'objet complet** (avec champs calculés pour une période). Pas de réponse partielle.

### Gestion des erreurs Express 5

Express 5 forward automatiquement les rejets de promesses des handlers async vers le middleware d'erreur. Donc on écrit simplement :

```js
app.get('/...', async (req, res) => {
  const x = await something();
  res.json(x);
});
```

Le middleware d'erreur final convertit toute exception en réponse JSON `{ error, message }` au format défini en §7.

### Logging

`console.log` pour démarrage + requêtes (méthode, path, status, durée).
`console.error` pour erreurs 5xx.
Format libre, pas de structure JSON imposée. À durcir si besoin futur.

## 12. Hors scope (à dater)

- Frontend web (sera un projet séparé, consommateur de cette API).
- Multi-utilisateur réel (schémas et logique métier mono-user pour l'instant).
- Catégories de dépenses.
- Exports CSV / PDF.
- Statistiques avancées (cumuls inter-périodes, moyennes, etc.).
- Pagination des listes.
