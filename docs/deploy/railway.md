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

## Before merging or deploying Plan 2 (do this first)

> **Important.** From Plan 2 onwards the `api` service **will not start** unless three new variables are set. Railway deploys `main` automatically, so set them **before** the Plan 2 changes are merged. If you merge first, the new `api` deployment keeps crashing (Railway keeps the old version running, but the deploy shows red until you add them).

1. In Railway, make sure the environment at the top says **production**.
2. Open the `api` service, then **Variables**.
3. Add these three (the **Variables** table below explains each one):
   - `BETTER_AUTH_SECRET`: a new random secret, letters and digits only, 48 characters.
   - `APP_BASE_URL`: `https://web-production-a648e.up.railway.app` (the `web` address, no `/` at the end).
   - `PLATFORM_ADMIN_EMAILS`: your own email address.
4. Click **Deploy** to apply the changes. The current (Plan 1) version keeps running; it simply ignores the new variables.
5. Only now merge the Plan 2 changes into `main`. When the new deploy finishes, run the checks in **Check that it works**.

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
| `BETTER_AUTH_SECRET`     | Its own long random secret: letters and digits only, 48 characters. It protects sign-in sessions. Use a different one in each environment, and never share it. |
| `APP_BASE_URL`           | The `web` public address, starting with `https://` and with no `/` at the end, e.g. `https://web-production-a648e.up.railway.app`. Invite and password-reset links use it. |
| `PLATFORM_ADMIN_EMAILS`  | The owner's email address. Only this email can create an account without an invitation, and it can create companies. To allow more than one, separate them with commas. |

| `BOOTSTRAP_OWNER_EMAIL`    | Optional, see **First owner login**. The owner's email; it must also be in `PLATFORM_ADMIN_EMAILS`. |
| `BOOTSTRAP_OWNER_PASSWORD` | Optional, see **First owner login**. A temporary password (at least 8 characters). Delete it after the first sign-in. |
| `FACE_TEMPLATE_KEY`        | Required: from the attendance release onwards `api` **will not start** in production without it, so add it before deploying. A random 32-byte key, base64-encoded, that encrypts the stored face templates used for attendance. Generate it with `openssl rand -base64 32` and use a different one in each environment. **Never change or lose it**: templates saved with the old key can no longer be read, and every worker would have to enrol again. |

**`web` service**

| Variable           | Value                                                 |
| ------------------ | ----------------------------------------------------- |
| `API_INTERNAL_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` |

Type the `${{ ... }}` parts exactly. Railway fills them in itself, and in each environment it uses that environment's own database.

**Memory.** Face recognition for attendance runs inside `api`, so the `api` service needs about **350 MB** of memory. Check its memory limit in the service settings. The face models load on the first attendance photo, which takes under a second.

## First owner login

Instead of using the **Create owner account** page, the `api` service can create the owner's account for you when it starts.

1. In `api`, then **Variables**, add both of these (set both or neither, or `api` will not start):
   - `BOOTSTRAP_OWNER_EMAIL`: the owner's email. It must also be listed in `PLATFORM_ADMIN_EMAILS`.
   - `BOOTSTRAP_OWNER_PASSWORD`: a temporary password, at least 8 characters.
2. Click **Deploy**. If no account with that email exists yet, the `api` logs show `Owner account created for <email>; password change required at first sign-in.` If the account already exists, nothing changes: its password is **never** reset by these variables.
3. Sign in on the `web` address with that email and the temporary password. Site Diary asks you to **Set a new password** (at least 10 characters) before anything else works. After saving, you land on **Platform admin**, and every other signed-in device is signed out.
4. **Then delete `BOOTSTRAP_OWNER_PASSWORD`** from the `api` variables (and `BOOTSTRAP_OWNER_EMAIL` too, if you like) and click **Deploy**. The temporary password no longer works, but it should not stay stored in Railway.

## Staging (a test copy)

A duplicated environment copies production's variables. Some of them **must** be changed in staging, or staging will block every sign-in and its emails will link to production.

1. At the top of the project, click the environment name (**production**), then **New Environment**, then **Duplicate Environment**. Pick **production** and name it `staging`.
2. Railway shows the copied services as pending changes. Review them and click **Deploy**.
3. In staging, open `web`, then **Settings**, then **Networking**, and click **Generate Domain**. Do this for `web` only. Copy the new address (it starts with `https://`).
4. In staging, open `api`, then **Variables**, and change these:
   - `APP_DB_PASSWORD`: a **different** random password (letters and digits only, 40 characters).
   - `BETTER_AUTH_SECRET`: a **different** random secret (letters and digits only, 48 characters). Never reuse production's.
   - `APP_BASE_URL`: the **staging** `web` address from step 3, with no `/` at the end. (If it still shows the production address, staging blocks every form with "Request blocked.")
   - `PLATFORM_ADMIN_EMAILS`: can stay the same as production.
5. Click **Deploy** to apply the changes, then run the checks below on the staging address.

## Check that it works

- Open the `web` address. You should see the Site Diary sign-in screen.
- Add `/api/health` to the end of the address. You should see `{"status":"ok","db":"up"}`.

If the health page shows an error, open `api`, then **Deployments**, then **View Logs**, and share the last lines.
