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

## Première fois avec GitHub ?

Voir **`docs/github-debutant.md`** dans ce dépôt : création du compte, dépôt distant, premiers commits et push.
