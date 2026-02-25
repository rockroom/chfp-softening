# CHFP Softening Project — Deployment Guide

## Overview

This deploys the CHFP water quality data entry app using:
- **Netlify** — hosts the React frontend (free tier)
- **Supabase** — PostgreSQL database with REST API (free tier)

Estimated setup time: **15–20 minutes**

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up / sign in
2. Click **New Project**
3. Choose a name (e.g., `chfp-softening`) and set a database password
4. Select the **US East** region (closest to Louisville)
5. Wait ~2 minutes for the project to provision

### Create the Database Table

1. In your Supabase dashboard, go to **SQL Editor** (left sidebar)
2. Click **New Query**
3. Paste the entire contents of `supabase/schema.sql`
4. Click **Run** — you should see "Success"

### Get Your API Keys

1. Go to **Settings → API** in the Supabase dashboard
2. Copy these two values (you'll need them in Step 3):
   - **Project URL** — looks like `https://abc123xyz.supabase.co`
   - **anon public key** — a long string starting with `eyJ...`

---

## Step 2: Push Code to GitHub

1. Create a new GitHub repository (e.g., `chfp-softening-app`)
2. Push the `chfp-app` folder to it:

```bash
cd chfp-app
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/chfp-softening-app.git
git branch -M main
git push -u origin main
```

---

## Step 3: Deploy to Netlify

1. Go to [netlify.com](https://www.netlify.com) and sign up / sign in
2. Click **Add new site → Import an existing project**
3. Connect to GitHub and select your `chfp-softening-app` repo
4. Netlify will auto-detect the build settings from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
5. **Before clicking Deploy**, go to **Site settings → Environment variables** and add:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |
| `VITE_TEAM_PASSWORD` | A shared password for your team (e.g., `WaterLab2026!`) |

6. Click **Deploy site**
7. Wait 1–2 minutes — Netlify will give you a URL like `https://chfp-softening.netlify.app`

### Custom Domain (Optional)

In Netlify **Site settings → Domain management**, you can add a custom domain or rename the default URL to something memorable.

---

## Step 4: Verify Everything Works

1. Open your Netlify URL in a browser
2. Enter the team password you set
3. Enter a few test values and click **Save Entry**
4. Check Supabase: go to **Table Editor → samples** — you should see a row
5. Test the QR code: click **Scan QR** and scan with your phone
6. On your phone, enter the password, take a photo of a test form

---

## How It Works

```
┌──────────────┐     HTTPS      ┌──────────────┐
│   Analyst's   │ ◄────────────► │   Netlify    │
│   Browser     │                │   (React)    │
└──────────────┘                └──────┬───────┘
                                       │ REST API
                                ┌──────▼───────┐
                                │   Supabase   │
                                │ (PostgreSQL) │
                                └──────────────┘
```

- The React app runs entirely in the browser
- Data reads/writes go directly from the browser to Supabase via their REST API
- The password gate is client-side (simple access control, not high security)
- The OCR feature calls the Anthropic API from the browser
- Multiple analysts can use the app simultaneously — last save wins

---

## Ongoing Maintenance

### Changing the Team Password
Update `VITE_TEAM_PASSWORD` in Netlify environment variables, then trigger a redeploy (Deploys → Trigger deploy).

### Backing Up Data
In Supabase, go to **Settings → Database → Backups**. The free tier includes daily automatic backups retained for 7 days. You can also export via SQL:

```sql
COPY samples TO STDOUT WITH CSV HEADER;
```

### Monitoring Usage
- **Supabase free tier**: 500 MB database, 50K monthly active users, 2 GB bandwidth
- **Netlify free tier**: 100 GB bandwidth, 300 build minutes/month
- For this use case (a few analysts, 3 entries per week), you'll never hit these limits

---

## Troubleshooting

| Issue | Solution |
|---|---|
| "Error" status when saving | Check browser console; verify Supabase URL and key are correct |
| Password not working after change | Clear sessionStorage or use incognito; redeploy after env var change |
| OCR not working | The Anthropic API call requires the artifact environment; for production OCR, you'd need a server-side proxy with an API key |
| Mobile upload doesn't appear on desktop | Click the ↻ refresh button to reload from database |

---

## Next Phase: LSI / CCPP Calculations

The database is structured to support adding chemistry calculations. The `values` JSONB column stores all analyte data in a queryable format. Future additions:
- Real-time LSI and CCPP calculation from pH, alkalinity, calcium, temperature, and conductivity
- Lime dosage estimation from upstream/downstream water chemistry deltas
- Trend charts pulling historical data from the `samples` table
