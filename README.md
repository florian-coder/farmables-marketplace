# Farmables

Monorepo with a Node/Express backend and a React/Vite frontend.

## Project Structure
- `local-farmers-backendd/` - Express API (`src/`, `tests/`)
- `local-farmers-frontendd/` - React UI (`src/`, `src/__tests__/`, `src/styles/`)
- `data/` - legacy JSON storage folder kept only for migration cleanup compatibility

## Quick Start
Backend:
```bash
cd local-farmers-backendd
npm install
cp .env.example .env
npm run dev
```

Frontend (new terminal):
```bash
cd local-farmers-frontendd
npm install
cp .env.example .env
npm run dev
```

## Testing
Backend:
```bash
cd local-farmers-backendd
npm test
```

Frontend:
```bash
cd local-farmers-frontendd
npm test
```

## Formatting & Linting
Run these inside each module:
```bash
npm run lint
npm run format
```

## Storage Notes
Core application data is loaded from Supabase tables and Supabase Storage buckets.
Legacy JSON files under `data/` are purged on API startup to prevent mixed-state conflicts.
