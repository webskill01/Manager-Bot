# EaseCab Panel

Web panel at **panel.easecab.com** for calling due members: today's queue across all bots,
focus calling over WhatsApp, follow-ups, team stats and an activity log. Its job: move
group members onto the EaseCab app (₹149). Whoever has paid on the app drops out of the queue.

It reads the bots' Google Sheets and the EaseCab app's member-sync API, polling every 2 minutes,
and keeps its own data (users, calls, follow-ups, assignments, audit) in `panel/panel.db` (SQLite).

## Run locally

```bash
cp panel/.env.example panel/.env        # fill in real values (gitignored)
cp <bots' service-account.json> panel/
cd panel/web && npm ci && npm run build && cd ../..
node panel/server.js                     # http://127.0.0.1:8110
```

For UI work, run `npm run dev` in `panel/web` (Vite proxies `/api` to 8110).
Tests: `node --test tests/panel-*.test.js`.

## Deploy (vmi3403631)

1. Pull the repo, then copy `panel/.env` and `panel/service-account.json` over with scp (both gitignored).
2. `cd panel/web && npm ci && npm run build`
3. `pm2 start ecosystem.config.cjs --only easecab-panel && pm2 save`
4. nginx site for `panel.easecab.com`:

   ```nginx
   server {
     listen 443 ssl;
     server_name panel.easecab.com;
     # ssl_certificate: Cloudflare origin cert
     location / {
       proxy_pass http://127.0.0.1:8110;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto https;
     }
   }
   ```

   Cloudflare SSL mode is "Full (strict)". The session cookie is `Secure`, so the panel only works over https.
5. First login: `PANEL_ADMIN_NAME` + `PANEL_PIN`, then set a 4-digit PIN. The same login resets a forgotten admin PIN; admins reset others from **Team**. Invite others from **Team**.

Updates: `git pull`, rebuild `panel/web`, `pm2 restart easecab-panel`.

## Backups

`panel/panel.db` is the only state the sheets can't rebuild (calls, notes, follow-ups, users).
Back it up daily, for example with `sqlite3 panel/panel.db ".backup panel-$(date +%F).db"` from cron.
