# Agent Forge Streak Tracker PWA 💰🔥

## Quick Start
1. Open `index.html` in your browser (e.g., `file:///path/to/agent-forge-streak/index.html` or serve via `npx serve .` / Python http.server).
2. Add to home screen via browser menu (Chrome/Safari).
3. Check in daily to build your streak!

## Features
- **Offline-first**: Works without internet (localStorage + SW).
- **Streak logic**: Resets on missed days, increments on consecutive.
- **PWA-ready**: Installable, themed, icons (SVG placeholders).
- **Responsive**: Mobile-first design.

## JS Learning Notes (Victor)
- **localStorage**: Simple key-value store. `JSON.parse/stringify` for objects.
- **Date handling**: `toISOString().split('T')[0]` for YYYY-MM-DD.
- **Service Worker**: Caches files for offline. Basic strategy here.
- **Manifest**: Defines PWA metadata. Icons are inline SVG (flame emoji-ish).
- **Animations**: CSS keyframes for fun (flicker, pulse).

## Customization
- Add best streak: Track `bestStreak: Math.max(bestStreak, streak)`
- Notifications: Use Notification API (ask permission).
- Sync: IndexedDB + sync for multi-device (advanced).
- Confetti: Add canvas-based or lib like canvas-confetti.

Serve locally: `npx serve` or `python -m http.server 8000`

Streak on! 🚀