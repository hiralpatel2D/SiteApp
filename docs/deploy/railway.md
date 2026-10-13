# Site Diary on Railway

**Current setup (production):** Railway project **blissful-spirit** · public address **https://web-production-a648e.up.railway.app**

Railway has retired "config as code" files (`railway.json`), so all settings below are entered on each service in the Railway dashboard, under **Settings**. Use this page to check the setup or to rebuild it from scratch.

## What runs where

| Service    | Public?               | What it does                                                             |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| `Postgres` | No                    | The database                                                             |
| `api`      | No (private network)  | The server. It sets up and updates the tables every time it starts       |
| `web`      | Yes (has the domain)  | The app people open. It passes `/api/...` requests to `api` privately    |

All three must keep these exact names, because the variables below refer to them.

## Service settings

Both services use the GitHub repo `hiralpatel2D/SiteApp`, branch `main`, root directory `/`, builder **Railpack**, and restart policy **On failure** (5 retries).

| Setting                | `api`                                                    | `web`                                                    |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Build command          | `pnpm install --frozen-lockfile`                         | `pnpm install --frozen-lockfile && pnpm --filter web build` |
| Start command          | `pnpm --filter api db:migrate && pnpm --filter api start` | `node apps/web/server.mjs`                               |
| Healthcheck path       | `/api/health`                                            | `/`                                                      |
| Healthcheck timeout    | 120 seconds                                              | 120 seconds                                              |
| Public domain          | **None** (keep it private)                               | Generate one                                             |

## Variables

**`api` service**

| Variable                 | Value                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3001`                                                                                                |
| `NODE_ENV`               | `production`                                                                                          |
| `APP_DB_PASSWORD`        | Its own long random password: letters and digits only, 40 characters. **Never** `${{Postgres.PGPASSWORD}}`, because the app's limited account must not share the master password. |
| `MIGRATION_DATABASE_URL` | `${{Postgres.DATABASE_URL}}`                                                                          |
| `DATABASE_URL`           | `postgresql://app_user:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |

**`web` service**

| Variable           | Value                                                 |
| ------------------ | ----------------------------------------------------- |
| `API_INTERNAL_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` |

Type the `${{ ... }}` parts exactly. Railway fills them in itself, and in each environment it uses that environment's own database.

## Staging (a test copy)

1. At the top of the project, click the environment name (**production**), then **New Environment**, then **Duplicate Environment**. Pick **production** and name it `staging`.
2. Railway shows the copied services as pending changes. Review them and click **Deploy**.
3. In staging, open `api`, then **Variables**, and give `APP_DB_PASSWORD` a different random password (letters and digits only).
4. In staging, open `web`, then **Settings**, then **Networking**, and click **Generate Domain**. Do this for `web` only.

## Check that it works

- Open the `web` address. You should see the Site Diary sign-in screen.
- Add `/api/health` to the end of the address. You should see `{"status":"ok","db":"up"}`.

If the health page shows an error, open `api`, then **Deployments**, then **View Logs**, and share the last lines.
