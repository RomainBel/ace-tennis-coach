# Ace — Coach tennis (IA)

Application web : tableau de bord joueur + chat Ace, backend FastAPI, frontend Next.js.

## Prérequis

- **Node.js** 20+ (recommandé) et npm  
- **Python** 3.10+ avec `venv`

## Installation

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows : .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Éditer .env : OPENAI_API_KEY, OPENAI_MODEL, etc.
```

Lancer l’API (port 8000 par défaut) :

```bash
uvicorn app.main:app --reload
```

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
# Éditer .env.local : AUTH_SECRET (obligatoire), URLs si besoin
npm run dev
```

Ouvre [http://localhost:3000](http://localhost:3000).

## Structure du dépôt

| Dossier     | Rôle                                      |
|------------|--------------------------------------------|
| `backend/` | API FastAPI, logique métier, prompts Ace  |
| `frontend/`| Next.js (App Router), dashboard, onboarding |

Les fichiers **`.env` et `.env.local` ne sont pas versionnés** — utilise `.env.example` comme modèle.

## Déployer le backend sur Render (Web Service)

Dans un dépôt mono‑repo (`frontend/` + `backend/`), le point le plus fréquent qui fait **échouer le démarrage** (après un build OK) est un mauvais **répertoire racine** : Uvicorn doit voir le package `app` dans le dossier courant.

Sur le service Render :

1. **Root Directory** : `backend` *(obligatoire si le repo contient aussi `frontend/`)*  
2. **Build Command** : `pip install -r requirements.txt`  
3. **Start Command** : `uvicorn app.main:app --host 0.0.0.0 --port $PORT`  
4. **Environment** : définir au minimum `OPENAI_API_KEY` et `OPENAI_MODEL` (voir `backend/.env.example`). Pour les liens « mot de passe oublié », `PUBLIC_APP_URL` = URL de ton frontend (ex. Vercel).

Les logs doivent afficher `>>> BACKEND IS STARTING...` puis une ligne `SQLite path: ...`. Si le processus s’arrête sans traceback, vérifie encore **Root Directory** = `backend`.

## Première fois avec GitHub ?

Voir **`docs/github-debutant.md`** dans ce dépôt : création du compte, dépôt distant, premiers commits et push.
