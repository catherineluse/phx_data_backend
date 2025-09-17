import express from 'express';
import pool from '../database';

const router = express.Router();

router.get('/kpi', async (req, res) => {
  try {
    const query = `
      WITH p AS (
        SELECT * FROM missing_persons_parsed
      )
      SELECT
        COUNT(*) AS total_reports,
        (
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (d_located - d_last_seen))
          FROM p
          WHERE d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen
        ) AS median_days_missing,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE d_located IS NULL AND d_last_seen IS NOT NULL) / NULLIF(COUNT(*), 0),
          2
        ) AS pct_still_missing
      FROM p;
    `;

    const result = await pool.query(query);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching KPI data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/monthly-reports', async (req, res) => {
  try {
    const query = `
      WITH parsed AS (
        SELECT
          CASE
            WHEN upper(btrim("reported_on")) IN ('', 'NOT AVAILABLE', 'N/A', 'NA', 'UNKNOWN') THEN NULL
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim("reported_on"), 'MM/DD/YY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim("reported_on"), 'MM/DD/YYYY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s*$'
              THEN to_timestamp(btrim("reported_on") || ' 12:00 AM', 'MM/DD/YYYY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s*$'
              THEN to_timestamp(btrim("reported_on") || ' 12:00 AM', 'MM/DD/YY  HH12:MI AM')
            ELSE NULL
          END AS rpt_ts
        FROM missing_persons
      ),
      month_bounds AS (
        SELECT
          date_trunc('month', MIN(rpt_ts)) AS min_mon,
          date_trunc('month', MAX(rpt_ts)) AS max_mon
        FROM parsed
        WHERE rpt_ts IS NOT NULL
      ),
      month_series AS (
        SELECT gs::date AS mon
        FROM month_bounds mb
        CROSS JOIN generate_series(mb.min_mon, mb.max_mon, interval '1 month') AS gs
      ),
      monthly_counts AS (
        SELECT
          date_trunc('month', rpt_ts)::date AS mon,
          COUNT(*)::int AS reports
        FROM parsed
        WHERE rpt_ts IS NOT NULL
        GROUP BY 1
      )
      SELECT
        ms.mon,
        COALESCE(mc.reports, 0) AS reports,
        ROUND(AVG(COALESCE(mc.reports, 0)) OVER (
              ORDER BY ms.mon
              ROWS BETWEEN 5 PRECEDING AND CURRENT ROW
        )::numeric, 2) AS ma_6mo,
        ROUND(AVG(COALESCE(mc.reports, 0)) OVER (
              ORDER BY ms.mon
              ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        )::numeric, 2) AS ma_12mo
      FROM month_series ms
      LEFT JOIN monthly_counts mc USING (mon)
      ORDER BY ms.mon;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly reports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/monthly-reports-with-anomaly', async (req, res) => {
  try {
    const query = `
      WITH base AS (
        WITH parsed AS (
          SELECT CASE
            WHEN upper(btrim("reported_on")) IN ('', 'NOT AVAILABLE', 'N/A', 'NA', 'UNKNOWN') THEN NULL
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim("reported_on"), 'MM/DD/YY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim("reported_on"), 'MM/DD/YYYY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s*$'
              THEN to_timestamp(btrim("reported_on") || ' 12:00 AM', 'MM/DD/YYYY  HH12:MI AM')
            WHEN btrim("reported_on") ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s*$'
              THEN to_timestamp(btrim("reported_on") || ' 12:00 AM', 'MM/DD/YY  HH12:MI AM')
            ELSE NULL
          END AS rpt_ts
          FROM missing_persons
        ),
        month_bounds AS (
          SELECT date_trunc('month', MIN(rpt_ts)) AS min_mon,
                 date_trunc('month', MAX(rpt_ts)) AS max_mon
          FROM parsed
          WHERE rpt_ts IS NOT NULL
        ),
        month_series AS (
          SELECT gs::date AS mon
          FROM month_bounds mb
          CROSS JOIN generate_series(mb.min_mon, mb.max_mon, interval '1 month') gs
        ),
        monthly_counts AS (
          SELECT date_trunc('month', rpt_ts)::date AS mon, COUNT(*)::int AS reports
          FROM parsed
          WHERE rpt_ts IS NOT NULL
          GROUP BY 1
        )
        SELECT
          ms.mon,
          COALESCE(mc.reports, 0) AS reports
        FROM month_series ms
        LEFT JOIN monthly_counts mc USING (mon)
      )
      SELECT
        mon,
        reports,
        ROUND(AVG(reports) OVER (ORDER BY mon ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)::numeric, 2) AS mean_12mo,
        ROUND(STDDEV_SAMP(reports) OVER (ORDER BY mon ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)::numeric, 2) AS sd_12mo,
        CASE
          WHEN STDDEV_SAMP(reports) OVER (ORDER BY mon ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) IS NULL
            THEN NULL
          ELSE ROUND(
            (reports - AVG(reports) OVER (ORDER BY mon ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)) /
            NULLIF(STDDEV_SAMP(reports) OVER (ORDER BY mon ROWS BETWEEN 11 PRECEDING AND CURRENT ROW), 0)
          ::numeric, 2)
        END AS zscore_12mo
      FROM base
      ORDER BY mon;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly reports with anomaly:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/time-to-located-histogram', async (req, res) => {
  try {
    const query = `
      WITH spans AS (
        SELECT
          CASE
            WHEN d_located IS NULL AND d_last_seen IS NOT NULL THEN 'Still Missing'
            WHEN d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen THEN
              CASE
                WHEN (d_located - d_last_seen) BETWEEN 0 AND 1  THEN '0-1d'
                WHEN (d_located - d_last_seen) BETWEEN 2 AND 7  THEN '2-7d'
                WHEN (d_located - d_last_seen) BETWEEN 8 AND 20 THEN '8-20d'
                WHEN (d_located - d_last_seen) BETWEEN 21 AND 89 THEN '21-89d'
                WHEN (d_located - d_last_seen) >= 90           THEN '90+d'
              END
            ELSE 'Unknown/Invalid'
          END AS bucket
        FROM missing_persons_parsed
      )
      SELECT
        bucket,
        COUNT(*) AS count,
        ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (),0), 2) AS pct_of_total
      FROM spans
      WHERE bucket IS NOT NULL
      GROUP BY bucket
      ORDER BY CASE bucket
        WHEN '0-1d' THEN 1
        WHEN '2-7d' THEN 2
        WHEN '8-20d' THEN 3
        WHEN '21-89d' THEN 4
        WHEN '90+d' THEN 5
        WHEN 'Still Missing' THEN 6
        ELSE 7
      END;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching time to located histogram:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/demographics/misstype', async (req, res) => {
  try {
    const query = `
      WITH parsed AS (
        SELECT
          CASE
            WHEN upper(btrim(reported_on)) IN ('', 'NOT AVAILABLE','N/A','NA','UNKNOWN') THEN NULL
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YY  HH12:MI AM')
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YYYY  HH12:MI AM')
            ELSE NULL
          END AS rpt_ts,
          CASE
            WHEN upper(btrim(misstype)) = 'ADULT'    THEN 'Adult'
            WHEN upper(btrim(misstype)) = 'JUVENILE' THEN 'Juvenile'
            ELSE 'Unknown'
          END AS misstype_cat
        FROM missing_persons
      ),
      bounds AS (
        SELECT date_trunc('month', MIN(rpt_ts)) AS min_mon,
               date_trunc('month', MAX(rpt_ts)) AS max_mon
        FROM parsed WHERE rpt_ts IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Adult')    AS adult,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Juvenile') AS juvenile,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Unknown')  AS unknown
      FROM months m
      LEFT JOIN parsed p ON date_trunc('month', p.rpt_ts)::date = m.mon
      GROUP BY m.mon
      ORDER BY m.mon;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching demographics by misstype:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/demographics/sex', async (req, res) => {
  try {
    const query = `
      WITH parsed AS (
        SELECT
          CASE
            WHEN upper(btrim(reported_on)) IN ('', 'NOT AVAILABLE','N/A','NA','UNKNOWN') THEN NULL
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YY  HH12:MI AM')
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YYYY  HH12:MI AM')
            ELSE NULL
          END AS rpt_ts,
          CASE
            WHEN upper(btrim(sex)) IN ('MALE','M')   THEN 'Male'
            WHEN upper(btrim(sex)) IN ('FEMALE','F') THEN 'Female'
            ELSE 'Unknown'
          END AS sex_cat
        FROM missing_persons
      ),
      bounds AS (
        SELECT date_trunc('month', MIN(rpt_ts)) AS min_mon,
               date_trunc('month', MAX(rpt_ts)) AS max_mon
        FROM parsed WHERE rpt_ts IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Male')   AS male,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Female') AS female,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Unknown') AS unknown
      FROM months m
      LEFT JOIN parsed p ON date_trunc('month', p.rpt_ts)::date = m.mon
      GROUP BY m.mon
      ORDER BY m.mon;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching demographics by sex:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/demographics/race', async (req, res) => {
  try {
    const query = `
      WITH parsed AS (
        SELECT
          CASE
            WHEN upper(btrim(reported_on)) IN ('', 'NOT AVAILABLE','N/A','NA','UNKNOWN') THEN NULL
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{2}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YY  HH12:MI AM')
            WHEN btrim(reported_on) ~ '^\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)\\s*$'
              THEN to_timestamp(btrim(reported_on), 'MM/DD/YYYY  HH12:MI AM')
            ELSE NULL
          END AS rpt_ts,
          race
        FROM missing_persons
      ),
      bounds AS (
        SELECT date_trunc('month', MIN(rpt_ts)) AS min_mon,
               date_trunc('month', MAX(rpt_ts)) AS max_mon
        FROM parsed WHERE rpt_ts IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      ),
      norm AS (
        SELECT
          date_trunc('month', rpt_ts)::date AS mon,
          CASE
            WHEN race ILIKE '%american indian%' OR race ILIKE '%alaskan native%'
                 OR race ILIKE '%native american%'                                THEN 'American Indian / Alaskan Native'
            WHEN race ILIKE '%asian%' OR race ILIKE '%pacific islander%'          THEN 'Asian / Pacific Islander'
            WHEN race ILIKE '%white%'                                             THEN 'White'
            WHEN race ILIKE '%black%'                                             THEN 'Black'
            WHEN race IS NULL OR UPPER(TRIM(race)) IN ('', 'UNKNOWN', 'NOT AVAILABLE', 'N/A', 'NA')
                                                                                  THEN 'Unknown'
            ELSE 'Unknown'
          END AS race5
        FROM parsed
        WHERE rpt_ts IS NOT NULL
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE n.race5 = 'White')                             AS "White",
        COUNT(*) FILTER (WHERE n.race5 = 'Black')                             AS "Black",
        COUNT(*) FILTER (WHERE n.race5 = 'Asian / Pacific Islander')          AS "Asian / Pacific Islander",
        COUNT(*) FILTER (WHERE n.race5 = 'American Indian / Alaskan Native')  AS "American Indian / Alaskan Native",
        COUNT(*) FILTER (WHERE n.race5 = 'Unknown')                           AS "Unknown"
      FROM months m
      LEFT JOIN norm n ON n.mon = m.mon
      GROUP BY m.mon
      ORDER BY m.mon;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching demographics by race:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/time-to-located-by-race', async (req, res) => {
  try {
    const query = `
      WITH spans AS (
        SELECT
          CASE
            WHEN d_located IS NULL AND d_last_seen IS NOT NULL THEN 'Still Missing'
            WHEN d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen THEN
              CASE
                WHEN (d_located - d_last_seen) BETWEEN 0 AND 1  THEN '0-1d'
                WHEN (d_located - d_last_seen) BETWEEN 2 AND 7  THEN '2-7d'
                WHEN (d_located - d_last_seen) BETWEEN 8 AND 20 THEN '8-20d'
                WHEN (d_located - d_last_seen) BETWEEN 21 AND 89 THEN '21-89d'
                WHEN (d_located - d_last_seen) >= 90           THEN '90+d'
              END
            ELSE 'Unknown/Invalid'
          END AS bucket,
          CASE
            WHEN race ILIKE '%american indian%' OR race ILIKE '%alaskan native%'
                 OR race ILIKE '%native american%'                                THEN 'American Indian / Alaskan Native'
            WHEN race ILIKE '%asian%' OR race ILIKE '%pacific islander%'          THEN 'Asian / Pacific Islander'
            WHEN race ILIKE '%white%'                                             THEN 'White'
            WHEN race ILIKE '%black%'                                             THEN 'Black'
            WHEN race IS NULL OR UPPER(TRIM(race)) IN ('', 'UNKNOWN', 'NOT AVAILABLE', 'N/A', 'NA')
                                                                                  THEN 'Unknown'
            ELSE 'Unknown'
          END AS race_category
        FROM missing_persons_parsed
      )
      SELECT
        bucket,
        race_category,
        COUNT(*) AS count
      FROM spans
      WHERE bucket IS NOT NULL
      GROUP BY bucket, race_category
      ORDER BY CASE bucket
        WHEN '0-1d' THEN 1
        WHEN '2-7d' THEN 2
        WHEN '8-20d' THEN 3
        WHEN '21-89d' THEN 4
        WHEN '90+d' THEN 5
        WHEN 'Still Missing' THEN 6
        ELSE 7
      END, race_category;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching time to located by race:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/time-to-located-by-sex', async (req, res) => {
  try {
    const query = `
      WITH spans AS (
        SELECT
          CASE
            WHEN d_located IS NULL AND d_last_seen IS NOT NULL THEN 'Still Missing'
            WHEN d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen THEN
              CASE
                WHEN (d_located - d_last_seen) BETWEEN 0 AND 1  THEN '0-1d'
                WHEN (d_located - d_last_seen) BETWEEN 2 AND 7  THEN '2-7d'
                WHEN (d_located - d_last_seen) BETWEEN 8 AND 20 THEN '8-20d'
                WHEN (d_located - d_last_seen) BETWEEN 21 AND 89 THEN '21-89d'
                WHEN (d_located - d_last_seen) >= 90           THEN '90+d'
              END
            ELSE 'Unknown/Invalid'
          END AS bucket,
          CASE
            WHEN UPPER(TRIM(sex)) IN ('MALE','M')   THEN 'Male'
            WHEN UPPER(TRIM(sex)) IN ('FEMALE','F') THEN 'Female'
            ELSE 'Unknown'
          END AS sex_category
        FROM missing_persons_parsed
      )
      SELECT
        bucket,
        sex_category,
        COUNT(*) AS count
      FROM spans
      WHERE bucket IS NOT NULL
      GROUP BY bucket, sex_category
      ORDER BY CASE bucket
        WHEN '0-1d' THEN 1
        WHEN '2-7d' THEN 2
        WHEN '8-20d' THEN 3
        WHEN '21-89d' THEN 4
        WHEN '90+d' THEN 5
        WHEN 'Still Missing' THEN 6
        ELSE 7
      END, sex_category;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching time to located by sex:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/time-to-located-by-misstype', async (req, res) => {
  try {
    const query = `
      WITH spans AS (
        SELECT
          CASE
            WHEN d_located IS NULL AND d_last_seen IS NOT NULL THEN 'Still Missing'
            WHEN d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen THEN
              CASE
                WHEN (d_located - d_last_seen) BETWEEN 0 AND 1  THEN '0-1d'
                WHEN (d_located - d_last_seen) BETWEEN 2 AND 7  THEN '2-7d'
                WHEN (d_located - d_last_seen) BETWEEN 8 AND 20 THEN '8-20d'
                WHEN (d_located - d_last_seen) BETWEEN 21 AND 89 THEN '21-89d'
                WHEN (d_located - d_last_seen) >= 90           THEN '90+d'
              END
            ELSE 'Unknown/Invalid'
          END AS bucket,
          CASE
            WHEN UPPER(TRIM(misstype)) = 'ADULT'    THEN 'Adult'
            WHEN UPPER(TRIM(misstype)) = 'JUVENILE' THEN 'Juvenile'
            ELSE 'Unknown'
          END AS misstype_category
        FROM missing_persons_parsed
      )
      SELECT
        bucket,
        misstype_category,
        COUNT(*) AS count
      FROM spans
      WHERE bucket IS NOT NULL
      GROUP BY bucket, misstype_category
      ORDER BY CASE bucket
        WHEN '0-1d' THEN 1
        WHEN '2-7d' THEN 2
        WHEN '8-20d' THEN 3
        WHEN '21-89d' THEN 4
        WHEN '90+d' THEN 5
        WHEN 'Still Missing' THEN 6
        ELSE 7
      END, misstype_category;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching time to located by misstype:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/ncic-acic-status', async (req, res) => {
  try {
    const query = `
      SELECT
        'NCIC Entered' as category,
        COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_entered)) = 'YES') AS yes_count,
        COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_entered)) = 'NO') AS no_count
      FROM missing_persons
      UNION ALL
      SELECT
        'NCIC Cleared' as category,
        COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_cleared)) = 'YES') AS yes_count,
        COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_cleared)) = 'NO') AS no_count
      FROM missing_persons
      UNION ALL
      SELECT
        'ACIC Entered' as category,
        COUNT(*) FILTER (WHERE UPPER(TRIM(acic_entered)) = 'YES') AS yes_count,
        COUNT(*) FILTER (WHERE UPPER(TRIM(acic_entered)) = 'NO') AS no_count
      FROM missing_persons
      UNION ALL
      SELECT
        'ACIC Cleared' as category,
        COUNT(*) FILTER (WHERE UPPER(TRIM(acic_cleared)) = 'YES') AS yes_count,
        COUNT(*) FILTER (WHERE UPPER(TRIM(acic_cleared)) = 'NO') AS no_count
      FROM missing_persons
      ORDER BY category;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching NCIC/ACIC status data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;