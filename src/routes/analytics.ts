import express from 'express';
import pool from '../database';

const router = express.Router();

router.get('/kpi', async (req, res) => {
  try {
    const query = `
      SELECT
        COUNT(*) AS total_reports,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (d_located - d_last_seen)) FILTER (
          WHERE d_located IS NOT NULL AND d_last_seen IS NOT NULL AND d_located >= d_last_seen
        ) AS median_days_missing,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE d_located IS NULL AND d_last_seen IS NOT NULL) / NULLIF(COUNT(*), 0),
          2
        ) AS pct_still_missing
      FROM missing_persons_parsed;
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
      WITH month_bounds AS (
        SELECT
          date_trunc('month', MIN(reported_on::date)) AS min_mon,
          date_trunc('month', MAX(reported_on::date)) AS max_mon
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      ),
      month_series AS (
        SELECT gs::date AS mon
        FROM month_bounds mb
        CROSS JOIN generate_series(mb.min_mon, mb.max_mon, interval '1 month') AS gs
      ),
      monthly_counts AS (
        SELECT
          date_trunc('month', reported_on::date)::date AS mon,
          COUNT(*)::int AS reports
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
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
        WITH month_bounds AS (
          SELECT date_trunc('month', MIN(reported_on::date)) AS min_mon,
                 date_trunc('month', MAX(reported_on::date)) AS max_mon
          FROM missing_persons_parsed
          WHERE reported_on IS NOT NULL
        ),
        month_series AS (
          SELECT gs::date AS mon
          FROM month_bounds mb
          CROSS JOIN generate_series(mb.min_mon, mb.max_mon, interval '1 month') gs
        ),
        monthly_counts AS (
          SELECT date_trunc('month', reported_on::date)::date AS mon, COUNT(*)::int AS reports
          FROM missing_persons_parsed
          WHERE reported_on IS NOT NULL
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
      WITH bounds AS (
        SELECT date_trunc('month', MIN(reported_on::date)) AS min_mon,
               date_trunc('month', MAX(reported_on::date)) AS max_mon
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      ),
      parsed AS (
        SELECT
          date_trunc('month', reported_on::date)::date AS mon,
          CASE
            WHEN upper(btrim(misstype)) = 'ADULT'    THEN 'Adult'
            WHEN upper(btrim(misstype)) = 'JUVENILE' THEN 'Juvenile'
            ELSE 'Unknown'
          END AS misstype_cat
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Adult')    AS adult,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Juvenile') AS juvenile,
        COUNT(*) FILTER (WHERE p.misstype_cat = 'Unknown')  AS unknown
      FROM months m
      LEFT JOIN parsed p ON p.mon = m.mon
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
      WITH bounds AS (
        SELECT date_trunc('month', MIN(reported_on::date)) AS min_mon,
               date_trunc('month', MAX(reported_on::date)) AS max_mon
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      ),
      parsed AS (
        SELECT
          date_trunc('month', reported_on::date)::date AS mon,
          CASE
            WHEN upper(btrim(sex)) IN ('MALE','M')   THEN 'Male'
            WHEN upper(btrim(sex)) IN ('FEMALE','F') THEN 'Female'
            ELSE 'Unknown'
          END AS sex_cat
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Male')   AS male,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Female') AS female,
        COUNT(*) FILTER (WHERE p.sex_cat = 'Unknown') AS unknown
      FROM months m
      LEFT JOIN parsed p ON p.mon = m.mon
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
      WITH bounds AS (
        SELECT date_trunc('month', MIN(reported_on::date)) AS min_mon,
               date_trunc('month', MAX(reported_on::date)) AS max_mon
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      ),
      months AS (
        SELECT gs::date AS mon
        FROM bounds b CROSS JOIN generate_series(b.min_mon, b.max_mon, interval '1 month') gs
      ),
      norm AS (
        SELECT
          date_trunc('month', reported_on::date)::date AS mon,
          CASE
            WHEN race ILIKE '%american indian%' OR race ILIKE '%alaskan native%'
                 OR race ILIKE '%native american%'                                THEN 'American Indian / Alaskan Native'
            WHEN race ILIKE '%asian%' OR race ILIKE '%pacific islander%'          THEN 'Asian / Pacific Islander'
            WHEN race ILIKE '%white%' AND UPPER(TRIM(ethnicity)) = 'HISPANIC'     THEN 'Hispanic White'
            WHEN race ILIKE '%white%' AND UPPER(TRIM(ethnicity)) = 'NON-HISPANIC' THEN 'Non-Hispanic White'
            WHEN race ILIKE '%white%'                                             THEN 'White (Ethnicity Unknown)'
            WHEN race ILIKE '%black%'                                             THEN 'Black'
            WHEN race IS NULL OR UPPER(TRIM(race)) IN ('', 'UNKNOWN', 'NOT AVAILABLE', 'N/A', 'NA')
                                                                                  THEN 'Unknown'
            ELSE 'Unknown'
          END AS race_ethnicity
        FROM missing_persons_parsed
        WHERE reported_on IS NOT NULL
      )
      SELECT
        m.mon,
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'Hispanic White')                    AS "Hispanic White",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'Non-Hispanic White')               AS "Non-Hispanic White",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'White (Ethnicity Unknown)')        AS "White (Ethnicity Unknown)",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'Black')                            AS "Black",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'Asian / Pacific Islander')         AS "Asian / Pacific Islander",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'American Indian / Alaskan Native') AS "American Indian / Alaskan Native",
        COUNT(*) FILTER (WHERE n.race_ethnicity = 'Unknown')                          AS "Unknown"
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
            WHEN mpp.d_located IS NULL AND mpp.d_last_seen IS NOT NULL THEN 'Still Missing'
            WHEN mpp.d_located IS NOT NULL AND mpp.d_last_seen IS NOT NULL AND mpp.d_located >= mpp.d_last_seen THEN
              CASE
                WHEN (mpp.d_located - mpp.d_last_seen) BETWEEN 0 AND 1  THEN '0-1d'
                WHEN (mpp.d_located - mpp.d_last_seen) BETWEEN 2 AND 7  THEN '2-7d'
                WHEN (mpp.d_located - mpp.d_last_seen) BETWEEN 8 AND 20 THEN '8-20d'
                WHEN (mpp.d_located - mpp.d_last_seen) BETWEEN 21 AND 89 THEN '21-89d'
                WHEN (mpp.d_located - mpp.d_last_seen) >= 90           THEN '90+d'
              END
            ELSE 'Unknown/Invalid'
          END AS bucket,
          CASE
            WHEN mpp.race ILIKE '%american indian%' OR mpp.race ILIKE '%alaskan native%'
                 OR mpp.race ILIKE '%native american%'                                THEN 'American Indian / Alaskan Native'
            WHEN mpp.race ILIKE '%asian%' OR mpp.race ILIKE '%pacific islander%'          THEN 'Asian / Pacific Islander'
            WHEN mpp.race ILIKE '%white%' AND UPPER(TRIM(mpp.ethnicity)) = 'HISPANIC'     THEN 'Hispanic White'
            WHEN mpp.race ILIKE '%white%' AND UPPER(TRIM(mpp.ethnicity)) = 'NON-HISPANIC' THEN 'Non-Hispanic White'
            WHEN mpp.race ILIKE '%white%'                                             THEN 'White (Ethnicity Unknown)'
            WHEN mpp.race ILIKE '%black%'                                             THEN 'Black'
            WHEN mpp.race IS NULL OR UPPER(TRIM(mpp.race)) IN ('', 'UNKNOWN', 'NOT AVAILABLE', 'N/A', 'NA')
                                                                                  THEN 'Unknown'
            ELSE 'Unknown'
          END AS race_category
        FROM missing_persons_parsed mpp
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
      WITH counts AS (
        SELECT
          COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_entered)) = 'YES') AS ncic_entered_yes,
          COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_entered)) = 'NO') AS ncic_entered_no,
          COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_cleared)) = 'YES') AS ncic_cleared_yes,
          COUNT(*) FILTER (WHERE UPPER(TRIM(ncic_cleared)) = 'NO') AS ncic_cleared_no,
          COUNT(*) FILTER (WHERE UPPER(TRIM(acic_entered)) = 'YES') AS acic_entered_yes,
          COUNT(*) FILTER (WHERE UPPER(TRIM(acic_entered)) = 'NO') AS acic_entered_no,
          COUNT(*) FILTER (WHERE UPPER(TRIM(acic_cleared)) = 'YES') AS acic_cleared_yes,
          COUNT(*) FILTER (WHERE UPPER(TRIM(acic_cleared)) = 'NO') AS acic_cleared_no
        FROM missing_persons
      )
      SELECT * FROM (
        VALUES
          ('ACIC Cleared', (SELECT acic_cleared_yes FROM counts), (SELECT acic_cleared_no FROM counts)),
          ('ACIC Entered', (SELECT acic_entered_yes FROM counts), (SELECT acic_entered_no FROM counts)),
          ('NCIC Cleared', (SELECT ncic_cleared_yes FROM counts), (SELECT ncic_cleared_no FROM counts)),
          ('NCIC Entered', (SELECT ncic_entered_yes FROM counts), (SELECT ncic_entered_no FROM counts))
      ) AS results(category, yes_count, no_count)
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