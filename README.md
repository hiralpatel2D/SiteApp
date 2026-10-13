# Site Diary

Multi-company construction SaaS. pnpm monorepo: `packages/shared`, `apps/api`, `apps/web` (api and web arrive in later tasks).

## Requirements

- Node 22 (`nvm use`)
- pnpm 10 (`corepack enable`)

## Commands

```sh
pnpm install        # install all workspaces
pnpm test           # Vitest (all projects)
pnpm typecheck      # tsc --noEmit in every workspace
pnpm lint           # ESLint
pnpm format:check   # Prettier check (use `pnpm format` to fix)
pnpm build          # build every workspace that has a build script
```

Run commands for the API and web apps will be added when those apps are scaffolded.
