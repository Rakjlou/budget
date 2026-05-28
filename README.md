# Budget Tracker — backend

Mono-user expense tracker organised in named, sequential periods (typically months). Exactly one period is open at any time; creating a new one atomically closes the previous. Spec: `cahier-des-charges.md`. API contract: `openapi.yaml`.

## Install

```bash
npm install
cp .env.example .env
npm run setup        # prompts username + password
```

## Run

```bash
npm start            # NODE_ENV=production, response validation off
npm run dev          # --watch, response validation on
```

The OpenAPI spec is served unauthenticated at `GET /openapi.yaml`. Every other endpoint is under `/api/v1` and requires Basic Auth.

## Stack

Node ≥ 24.15, ESM, Express 5, `node:sqlite`, `argon2`, `express-openapi-validator`. Three runtime dependencies in total.
