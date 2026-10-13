# Putting Site Diary on Railway

You do this once. It takes about 20 minutes. You need a Railway account and access to the `hiralpatel2D/SiteApp` repository on GitHub.

## What you are building

- A **Postgres** database (stores everything).
- An **api** service (the server brain, private, not on the internet).
- A **web** service (the app people open in their browser; it passes requests to `api`).

## Steps

1. Sign in to Railway and click **New Project**, then **Deploy from GitHub repo**, and pick `hiralpatel2D/SiteApp`. If Railway starts a service automatically, you will rename it in step 4.
2. In the project, click **New**, then **Database**, then **Add PostgreSQL**. Wait for it to turn green.
3. Click **New**, then **GitHub Repo**, and pick `hiralpatel2D/SiteApp` a second time. You now have two services from this repo.
4. Rename them so they are easy to tell apart (click the service, **Settings**, **Service Name**): call one `api` and the other `web`. The names must be exactly `api` and `web`, because step 7 refers to them.
5. For each service open **Settings** and set:
   - **Root Directory**: `/` (leave it as the repository root).
   - **Config as Code** (Railway calls it "Config File Path"): `/apps/api/railway.json` for `api`, and `/apps/web/railway.json` for `web`.
6. Open the `api` service, go to **Variables**, and add these three:
   - `MIGRATION_DATABASE_URL`: the database address used to set up and update the tables. It must be Railway's `postgres` superuser URL. Copy it from the Postgres service, **Variables**, `DATABASE_URL` (the one that starts with `postgresql://postgres:`). Use the private one (host ending `.railway.internal`).
   - `DATABASE_URL`: the address the running app uses, with the limited `app_user` account. Take the same URL as above and replace `postgres` (the user name) with `app_user`, and the password with the value you choose for `APP_DB_PASSWORD`. Host, port, and database name stay the same. Example shape: `postgresql://app_user:YOUR_APP_DB_PASSWORD@HOST:PORT/railway`.
   - `APP_DB_PASSWORD`: a long random password you invent (for example from a password manager). The first deploy creates the `app_user` account with this password, so it must match the password inside `DATABASE_URL`.
7. Open the `web` service, go to **Variables**, and add:
   - `API_INTERNAL_URL`: tells the website where the `api` lives inside Railway. Enter exactly: `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`
8. Make sure `api` also has a variable `PORT` set to `3001` (otherwise the line above will not resolve).
9. Create the staging copy: at the top of the project click the environment name (usually **production**), choose **New Environment**, name it `staging`, and duplicate from production. Repeat steps 6 and 7 inside `staging` if Railway did not copy the variables, and give staging its own `APP_DB_PASSWORD`.
10. Deploy: open each service and click **Deploy** (or push a change to the repository). Deploy `api` first, wait until it shows **Active**, then `web`.
11. Open the `web` service, **Settings**, **Networking**, and click **Generate Domain**. Do this for `web` only. Do not give `api` a public domain; it should stay private.

## Check that it worked

- Open the `web` address in your browser. You should see the Site Diary sign-in screen.
- Add `/api/health` to the end of that address. You should see `{"status":"ok","db":"up"}`.

If the health page shows an error, open the `api` service, then **Deployments**, then **View Logs**, and send the last few lines to your developer.

## The four variables in one place

| Variable                 | Service | What it is                                                           |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL` | api     | Railway's `postgres` superuser URL; used only to set up the tables   |
| `DATABASE_URL`           | api     | Same database, but signed in as `app_user`; used while the app runs  |
| `APP_DB_PASSWORD`        | api     | The password given to `app_user`; must match the one in the URL      |
| `API_INTERNAL_URL`       | web     | Private address of `api`: `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` |
