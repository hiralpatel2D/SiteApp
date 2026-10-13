# Putting Site Diary on Railway

You do this once. It takes about 20 minutes. You need a Railway account and access to the `hiralpatel2D/SiteApp` repository on GitHub.

## What you are building

- A **Postgres** database (stores everything).
- An **api** service (the server brain, private, not on the internet).
- A **web** service (the app people open in their browser; it passes requests to `api`).

## Steps

1. Sign in to Railway and click **New Project**, then **Empty Project**. (Do not pick "Deploy from GitHub repo" here; you add the services yourself below so there are no stray extras.)
2. In the project, click **New**, then **Database**, then **Add PostgreSQL**. Wait for it to turn green. Keep its name as `Postgres`, because the variables below refer to it.
3. Click **New**, then **GitHub Repo**, and pick `hiralpatel2D/SiteApp`. Do this twice, so you have two services from this repo.
4. Rename them so they are easy to tell apart (click the service, **Settings**, **Service Name**): call one `api` and the other `web`. The names must be exactly `api` and `web`, because step 7 refers to them.
5. For each service open **Settings** and set:
   - **Root Directory**: `/` (leave it as the repository root).
   - **Config as Code** (Railway calls it "Config File Path"): `/apps/api/railway.json` for `api`, and `/apps/web/railway.json` for `web`.
6. Open the `api` service, go to **Variables**, and add these four. Type them exactly as shown, including the `${{ ... }}` parts: Railway fills those in by itself, and it fills in the right values again in the staging copy, so you never paste a database address.
   - `PORT`: `3001`
   - `APP_DB_PASSWORD`: a long random password you invent. Use letters and digits only, 32 or more characters (for example `k8Jd2mQ7...`). Do not use symbols such as `@ / : # %`, because the password goes inside a web address and symbols break it. The first deploy creates the limited `app_user` account with this password.
   - `MIGRATION_DATABASE_URL`: `${{Postgres.DATABASE_URL}}` (the address used to set up and update the tables, as Railway's `postgres` superuser).
   - `DATABASE_URL`: `postgresql://app_user:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (the address the running app uses, with the limited `app_user` account).
7. Open the `web` service, go to **Variables**, and add:
   - `API_INTERNAL_URL`: tells the website where the `api` lives inside Railway. Enter exactly: `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`
8. Create the staging copy: at the top of the project click the environment name (usually **production**), choose **New Environment**, name it `staging`, and duplicate from production. Then open `api`, **Variables**, inside `staging` and change only `APP_DB_PASSWORD` to a different password. Everything else follows automatically.
9. Deploy: open each service and click **Deploy** (or push a change to the repository). Deploy `api` first, wait until it shows **Active**, then `web`. Do the same in `staging`.
10. Open the `web` service, **Settings**, **Networking**, and click **Generate Domain**. Do this for `web` only. Do not give `api` a public domain; it should stay private.

## Check that it worked

- Open the `web` address in your browser. You should see the Site Diary sign-in screen.
- Add `/api/health` to the end of that address. You should see `{"status":"ok","db":"up"}`.

If the health page shows an error, open the `api` service, then **Deployments**, then **View Logs**, and send the last few lines to your developer.

## The variables in one place

| Variable                 | Service | What it is                                                           |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `PORT`                   | api     | `3001`; the `web` service uses it to find `api`                      |
| `MIGRATION_DATABASE_URL` | api     | `${{Postgres.DATABASE_URL}}`; used only to set up the tables         |
| `DATABASE_URL`           | api     | Same database as `app_user`, built from the Postgres variables       |
| `APP_DB_PASSWORD`        | api     | The password given to `app_user`; the URL picks it up automatically |
| `API_INTERNAL_URL`       | web     | Private address of `api`: `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` |
