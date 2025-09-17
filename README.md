# Phoenix Missing Persons Data Backend

Express.js TypeScript backend for serving Phoenix Police Department missing persons data analytics.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your Neon PostgreSQL connection string:
   ```
   DATABASE_URL=postgresql://username:password@your-neon-db.neon.tech/dbname?sslmode=require
   PORT=3001
   ```

3. Ensure your database has the required tables:
   - `missing_persons` (raw data)
   - `missing_persons_parsed` (processed data with date parsing)

## Development

Start the development server:
```bash
npm run dev
```

The server will run on http://localhost:3001

## API Endpoints

- `GET /api/analytics/kpi` - Key performance indicators
- `GET /api/analytics/monthly-reports` - Monthly reports with rolling averages
- `GET /api/analytics/monthly-reports-with-anomaly` - Monthly reports with anomaly detection
- `GET /api/analytics/time-to-located-histogram` - Time to located distribution
- `GET /api/analytics/demographics/misstype` - Demographics by missing type
- `GET /api/analytics/demographics/sex` - Demographics by sex
- `GET /api/analytics/demographics/race` - Demographics by race
- `GET /health` - Health check endpoint

## Production

Build and start:
```bash
npm run build
npm start
```