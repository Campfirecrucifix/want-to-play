# Want to Play

A personal "want to play" game tracker for Android. It tracks release status (unreleased / coming soon with countdown / early access / released / demo), player modes (single, co-op, online co-op, local co-op, PvP, MMO) and themes (Steam tags).

- `web/` – the actual app (plain HTML/JS), served by GitHub Pages. Pushing here updates the app on every phone automatically.
- `android/` – a thin WebView shell: native Steam proxy (avoids CORS), 12-hourly background refresh with status-change notifications, share/export. Builds are signed in GitHub Actions and published as Releases.

Your game list is stored only on your device (plus an optional **secret gist** on your own GitHub account if you turn on sync).

Data: Steam `IStoreBrowseService/GetItems` (batched release/category/tag info) and `storesearch`.
