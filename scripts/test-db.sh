#!/usr/bin/env bash
# Local throwaway Postgres for tests. Usage: scripts/test-db.sh start|stop|status
#
# - Data lives in ./.pgdata (git-ignored), listening on 127.0.0.1:54329.
# - When invoked as root, initdb/pg_ctl run as the `postgres` system user
#   (initdb refuses to run as root). As a normal user they run as that user.
# - `start` creates the database `sitediary_test` and prints the env lines
#   for apps/api/.env.test. In CI a Postgres service container is used instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA_DIR="$ROOT/.pgdata"
PORT="${TEST_DB_PORT:-54329}"
DB_NAME="sitediary_test"
SUPERUSER="postgres"
SUPERUSER_PASSWORD="${TEST_DB_SUPERUSER_PASSWORD:-postgres}"
APP_PASSWORD="${TEST_DB_APP_PASSWORD:-app_user_test_password}"

if [ -x /usr/lib/postgresql/16/bin/pg_ctl ]; then
  PGBIN="/usr/lib/postgresql/16/bin"
else
  PGBIN="$(dirname "$(command -v pg_ctl)")"
fi

# Run a command as the database OS user.
as_db_user() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

psql_super() {
  PGPASSWORD="$SUPERUSER_PASSWORD" "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" \
    -v ON_ERROR_STOP=1 -qtA "$@"
}

start() {
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    mkdir -p "$PGDATA_DIR"
    if [ "$(id -u)" -eq 0 ]; then chown postgres:postgres "$PGDATA_DIR"; fi
    chmod 700 "$PGDATA_DIR"
    pwfile="$(mktemp)"
    trap 'rm -f "$pwfile"' EXIT
    printf '%s\n' "$SUPERUSER_PASSWORD" >"$pwfile"
    if [ "$(id -u)" -eq 0 ]; then chown postgres "$pwfile"; fi
    as_db_user "$PGBIN/initdb" -D "$PGDATA_DIR" -U "$SUPERUSER" --pwfile="$pwfile" \
      --auth-host=scram-sha-256 --auth-local=trust -E UTF8 >/dev/null
  fi

  if ! as_db_user "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    as_db_user "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -k $PGDATA_DIR" start >/dev/null
  fi

  if [ "$(psql_super -d postgres -c "select 1 from pg_database where datname = '$DB_NAME'")" != "1" ]; then
    psql_super -d postgres -c "create database $DB_NAME" >/dev/null
  fi

  echo "# Test database is running. Put these lines in apps/api/.env.test:"
  echo "MIGRATION_DATABASE_URL=postgres://$SUPERUSER:$SUPERUSER_PASSWORD@127.0.0.1:$PORT/$DB_NAME"
  echo "DATABASE_URL=postgres://app_user:$APP_PASSWORD@127.0.0.1:$PORT/$DB_NAME"
  echo "APP_DB_PASSWORD=$APP_PASSWORD"
  echo "BETTER_AUTH_SECRET=test-only-better-auth-secret-0123456789abcdef"
  echo "APP_BASE_URL=http://localhost:5173"
  echo "PLATFORM_ADMIN_EMAILS=owner@sitediary.test"
}

stop() {
  if [ -s "$PGDATA_DIR/PG_VERSION" ] &&
    as_db_user "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    as_db_user "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null
    echo "Test database stopped."
  else
    echo "Test database is not running."
  fi
}

status() {
  if [ -s "$PGDATA_DIR/PG_VERSION" ]; then
    as_db_user "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status
  else
    echo "Test database is not initialised."
    return 3
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *)
    echo "Usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
