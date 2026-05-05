# Utiliser GitHub pour la première fois

Ce guide part de zéro : compte GitHub → ton code poussé en ligne dans un dépôt **privé** (tu peux le passer en public plus tard si tu veux).

## Concepts rapides

- **Git** : outil local qui enregistre l’historique des versions de ton projet (commits).
- **GitHub** : site qui héberge une copie de ton dépôt et permet sauvegarder / partager / collaborer.

## 1. Créer un compte GitHub

1. Va sur [https://github.com](https://github.com) et inscris-toi.
2. Vérifie ton e-mail si demandé.

## 2. Créer un nouveau dépôt (vide) sur GitHub

1. Une fois connecté, clique **New** (ou **+** → **New repository**).
2. **Repository name** : par ex. `ace-tennis` ou `projets-ia`.
3. Choisis **Private** (recommandé tant que tu as des clés API en local — le code public ne doit jamais contenir de secrets).
4. **Ne coche pas** « Add a README » ni .gitignore (on les a déjà en local).
5. Clique **Create repository**.

GitHub affiche ensuite des commandes : garde la page ouverte, on s’en servira à l’étape 5.

## 3. Installer Git sur ton Mac (si besoin)

Dans le Terminal :

```bash
git --version
```

Si la commande n’existe pas, installe les **Xcode Command Line Tools** :

```bash
xcode-select --install
```

## 4. Configurer Git (une fois)

Remplace par ton nom et l’e-mail de ton compte GitHub :

```bash
git config --global user.name "Ton Prénom"
git config --global user.email "ton-email@exemple.com"
```

## 5. Initialiser le projet et le premier commit (dans le dossier du projet)

Dans le Terminal, place-toi à la **racine** du projet (le dossier qui contient `README.md`, `frontend/`, `backend/`) :

```bash
cd "/Users/romainb/Documents/Projets IA"
git init
git add .
git status
```

Vérifie dans `git status` qu’il **n’y a pas** :

- `backend/.env`
- `frontend/.env.local`

S’ils apparaissent, **ne continue pas** : dis-moi ou vérifie que le `.gitignore` racine est bien présent.

Puis :

```bash
git commit -m "Initial commit: Ace coach tennis (frontend + backend)"
```

## 6. Lier ton dossier local à GitHub et pousser

Sur la page GitHub de ton dépôt vide, choisis **HTTPS** et copie l’URL, par ex. :

`https://github.com/TON_USER/ace-tennis.git`

Puis dans le Terminal (même dossier racine) :

```bash
git branch -M main
git remote add origin https://github.com/TON_USER/ace-tennis.git
git push -u origin main
```

- La première fois, GitHub demandera de **t’authentifier** : en général un **Personal Access Token** (PAT) à la place du mot de passe, ou l’**application GitHub Desktop** / **Git Credential Manager**. Suis les instructions affichées dans le terminal ou [la doc GitHub sur HTTPS](https://docs.github.com/en/get-started/git-basics/about-remote-repositories#cloning-with-https-urls).

Quand `git push` réussit, rafraîchis la page GitHub : tu dois voir tes fichiers.

## 7. Ensuite, au quotidien

Après des modifications :

```bash
git status
git add .
git commit -m "Description courte du changement"
git push
```

## Sécurité indispensable

- **Ne commite jamais** `backend/.env` ni `frontend/.env.local` (clés OpenAI, `AUTH_SECRET`, etc.).
- Si une clé a fuité (collée par erreur sur GitHub, dans un chat, etc.) : **révoque-la** sur le site du fournisseur (ex. OpenAI) et crée-en une nouvelle.

## Besoin d’aide ?

- [Documentation GitHub « Hello World »](https://docs.github.com/en/get-started/quickstart/hello-world)
- En cas de message d’erreur au `git push`, copie-colle le texte exact : on pourra le décoder ligne par ligne.
