# Gino's copy

Published at `https://mannix77.github.io/2026Ignite/gino/` by the same deploy that publishes the main site. It has the same catalogs and updates, but its own picks, notes and settings (even on a phone that also has the main app installed), and no pre-loaded favorites.

Anything in `data/` here is copied over the published copy, so you can add your own:

- `data/gartner2026/favorites.json` and/or `data/ignite2026/favorites.json` — your workbook ranking, imported on first launch (and from Settings). Build one with
  `python3 scripts/import_gartner.py <your export.json> --workbook <your xlsx> --favorites-only --favorites-out instances/gino/data/gartner2026/favorites.json`
  (notes stay in the backup file it writes to `~/Downloads`, not in the repo).

To change the app itself, fork the repository and turn on GitHub Pages (Settings → Pages → Source: GitHub Actions); your fork gets its own address and keeps syncing the Ignite catalog.
