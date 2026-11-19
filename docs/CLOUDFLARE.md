# Hosting TradeQuest on Cloudflare

This puts TradeQuest on the internet behind a password, so you can open it from your phone. Your journal is kept in a Cloudflare D1 database. D1 can restore the database to any point in the last 7 days on the free plan (30 days on paid).

The local version (`npm start`) keeps working exactly as before. The two versions don't share data: you move your journal across once (step 6), then use the hosted one.

**What it costs:** the free Workers plan is enough for one person's journal. If you ever see "Exceeded CPU time" errors (possible with a very large journal), the Workers Paid plan ($5/month) removes that limit.

## Easiest: all in the browser (no command line)

1. **Create the database.** In dash.cloudflare.com, go to **Storage & databases → D1 → Create database** and name it `tradequest`. Copy its **Database ID**.
2. **Put the ID in the repo.** On github.com, open `wrangler.toml` in `vikslap/tradeq`, click ✏️ Edit, and replace `PASTE-YOUR-DATABASE-ID-HERE` with the ID. Commit.
3. **Connect the repo.** Go to **Workers & Pages → Create application → Import a repository**, connect GitHub, and pick `vikslap/tradeq`. The project name must be **`tradequest`** (the same as `name` in `wrangler.toml`). Leave the build command empty, set the deploy command to `npx wrangler deploy`, then **Save and Deploy**.
4. **Add the secrets.** Open the `tradequest` Worker → **Settings → Variables and Secrets → Add**. Set the type to **Secret** and add `APP_PASSWORD` (12+ characters), plus `KITE_API_KEY` and `KITE_API_SECRET` if you use Kite.
5. Open the `…workers.dev` address shown on the Worker's page, then continue with steps 5–7 below (Kite redirect URL, moving your journal, phone).

After this, every push to GitHub redeploys automatically.

The command-line route below does the same thing.

## 1. One-time setup

You need a free Cloudflare account (dash.cloudflare.com) and Node 18+ (you already have it).

Open PowerShell in your `tradeq` folder, then run:

```powershell
git pull
npx wrangler login
```

A browser window opens. Log in to Cloudflare and allow access.

## 2. Create the database

```powershell
npx wrangler d1 create tradequest
```

It prints a block that includes `database_id = "…"`. Open `wrangler.toml` and replace `PASTE-YOUR-DATABASE-ID-HERE` with that id. The id isn't a secret, so it's fine to commit it.

## 3. Set your password and Kite keys

These are stored encrypted by Cloudflare, never in a file. Each command asks you to type the value.

```powershell
npx wrangler secret put APP_PASSWORD
npx wrangler secret put KITE_API_KEY
npx wrangler secret put KITE_API_SECRET
```

Use a long password for `APP_PASSWORD` (12+ characters): it is all that stands between the internet and your journal. The Kite keys are optional. Without them the app runs in manual-price mode.

## 4. Deploy

```powershell
npx wrangler deploy
```

It prints your address, e.g. `https://tradequest.<your-subdomain>.workers.dev`. Open it and log in with your password.

To update later, run `git pull` and then `npx wrangler deploy` again.

## 5. Point Kite at the hosted version

In developers.kite.trade, open your TradeQuest app and change the **Redirect URL** to:

```
https://tradequest.<your-subdomain>.workers.dev/api/kite/callback
```

Settings → Kite in the hosted app shows the exact URL to copy.

A Kite app has only one redirect URL. After this change, **Connect to Kite** only works on the hosted version. The local version still works with manual prices. To use Kite locally again, switch the URL back to `http://127.0.0.1:5173/api/kite/callback`.

Then press **Connect to Kite** in the hosted Settings. As before, the login lasts until about 6 AM the next morning.

## 6. Move your journal across

1. Local app (`npm start`) → Settings → **⬇ Export JSON**.
2. Hosted app → Settings → **⬆ Import JSON** → choose that file.

Practice sessions, reviews and linked trades all come along.

## 7. On your phone

Open the address in Chrome, log in, then use the menu → **Add to Home screen**. It opens full-screen like an app. You stay logged in for 60 days per device. To log out, go to Settings → Log out of TradeQuest.

## Backups

- Settings → Export JSON works the same as locally.
- Full database copy: `npx wrangler d1 export tradequest --remote --output tradequest-backup.sql`
- Undo a mistake: `npx wrangler d1 time-travel restore tradequest --timestamp "2026-11-18T10:00:00+05:30"`

## How the hosted version differs

- **Storage:** D1 instead of `data/journal.json`. Each trade is its own row, so a change writes only what changed.
- **Login:** a password, kept as a signed, HttpOnly cookie. Changing `APP_PASSWORD` logs out every device.
- **Symbol search:** this runs in your browser. Kite's instrument list is too big for the Worker to parse on every request. The first search of the day downloads the lists (a few MB, NFO is the largest), and later searches that day are instant. On a phone, the first search may take a few seconds.
- **No orders:** like the local version, TradeQuest only reads from Kite (quotes, candles, holdings, positions, fills). It never places orders.

## Trying it locally first (optional)

```powershell
"APP_PASSWORD=testpass123`nKITE_MOCK=1" | Out-File -Encoding ascii .dev.vars
npx wrangler dev
```

Then open http://127.0.0.1:8787. This uses a throwaway local database and demo prices. `.dev.vars` is git-ignored.
