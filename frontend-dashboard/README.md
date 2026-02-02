# ⚡ Flash Arb Dashboard

Dashboard de monitoring pour le bot d'arbitrage flash loan Solana.

## Fonctionnalités

- 📊 **Stats en temps réel** - Profit, scans, trades exécutés
- 🎯 **Opportunités** - Liste des spreads détectés avec détails
- 📜 **Historique** - Transactions avec statut et signatures
- 📈 **Graphique** - Évolution des profits sur 24h

## Déploiement sur Netlify

### 1. Push sur GitHub
```bash
git add .
git commit -m "Add frontend dashboard"
git push origin main
```

### 2. Déploiement Netlify
1. Connecte-toi à [Netlify](https://netlify.com)
2. "Add new site" → "Import an existing project"
3. Sélectionne le repo GitHub
4. Configure:
   - **Base directory**: `frontend-dashboard`
   - **Build command**: `npm run build`
   - **Publish directory**: `frontend-dashboard/dist`
5. Deploy!

## Développement local

```bash
cd frontend-dashboard
npm install
npm run dev
```

## Technologies

- ⚛️ React 18 + TypeScript
- 🎨 Tailwind CSS
- 🎭 Framer Motion
- 🔥 Vite
- 🎯 Lucide Icons

## Connexion au bot

Pour connecter le dashboard au bot en temps réel, il faudra:
1. Ajouter un endpoint WebSocket au bot
2. Configurer l'URL dans le dashboard

Pour l'instant, le dashboard affiche des données de démonstration.
