# Farmables Frontend

React + Vite frontend for the Farmables marketplace.

## Requirements
- Node.js 18+
- npm

## Setup
```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts
- `npm run dev` - start the Vite dev server.
- `npm run build` - build for production.
- `npm run preview` - preview the production build.
- `npm test` - run Vitest + Testing Library tests.
- `npm run lint` - run ESLint.
- `npm run format` - check formatting with Prettier.

## Environment
- `VITE_API_URL` - backend API base URL (default: http://localhost:3000)
- `VITE_SUPABASE_URL` - Supabase project URL (optional override)
- `VITE_SUPABASE_PUBLISHABLE_KEY` - Supabase publishable key (optional override)
