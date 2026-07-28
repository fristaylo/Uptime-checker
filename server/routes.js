import express from "express";
import pool from "./db.js";
import { locationGroups, domains as monitoredDomains } from "./httpCheck.js";

const router = express.Router();

const HOURLY_THRESHOLD_MS = 48 * 60 * 60 * 1000;

const TIME_RANGE_CONFIG = {
    month: { interval: "30 day", spanMs: 30 * 24 * 60 * 60 * 1000 },
    week: { interval: "7 day", spanMs: 7 * 24 * 60 * 60 * 1000 },
    day: { interval: "1 day", spanMs: 24 * 60 * 60 * 1000 },
    "3hour": { interval: "3 hour", spanMs: 3 * 60 * 60 * 1000 },
};

const parseDate = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
};

const buildTimeFilter = ({ type, timeRange, dateFrom, dateTo }) => {
    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);

    if (from && to && from < to) {
        const spanMs = to.getTime() - from.getTime();
        const useHourly = spanMs >= HOURLY_THRESHOLD_MS;
        const tableName =
            type === "http"
                ? useHourly
                    ? "http_hourly_logs"
                    : "http_logs"
                : useHourly
                  ? "ping_hourly_logs"
                  : "ping_logs";
        return {
            tableName,
            whereSql: "created_at >= $1 AND created_at <= $2",
            params: [from.toISOString(), to.toISOString()],
        };
    }

    const cfg = TIME_RANGE_CONFIG[timeRange] ?? TIME_RANGE_CONFIG["3hour"];
    const useHourly = cfg.spanMs >= HOURLY_THRESHOLD_MS;
    const tableName =
        type === "http"
            ? useHourly
                ? "http_hourly_logs"
                : "http_logs"
            : useHourly
              ? "ping_hourly_logs"
              : "ping_logs";
    return {
        tableName,
        whereSql: "created_at >= NOW() - $1::interval",
        params: [cfg.interval],
    };
};

router.get("/http-logs", async (req, res) => {
    try {
        const { timeRange, domain, dateFrom, dateTo } = req.query;

        const { tableName, whereSql, params } = buildTimeFilter({
            type: "http",
            timeRange,
            dateFrom,
            dateTo,
        });

        const columns = `country, city, status_code, created_at, total_time, download_time, first_byte_time, dns_time, tls_time, tcp_time, server_timing`;

        let query;
        let queryParams;

        if (domain) {
            query = `
        SELECT
          ${columns}
        FROM ${tableName}
        WHERE ${whereSql} AND city IS NOT NULL AND domain = $${params.length + 1}
        ORDER BY created_at ASC;
      `;
            queryParams = [...params, domain];
        } else {
            query = `
        SELECT
          domain, ${columns}
        FROM ${tableName}
        WHERE ${whereSql} AND city IS NOT NULL
        ORDER BY created_at ASC;
      `;
            queryParams = params;
        }

        const { rows } = await pool.query(query, queryParams);

        if (domain) {
            const logsByCountryCity = {};
            for (const row of rows) {
                const { country, city, ...logData } = row;
                if (!logsByCountryCity[country]) {
                    logsByCountryCity[country] = {};
                }
                if (!logsByCountryCity[country][city]) {
                    logsByCountryCity[country][city] = [];
                }
                logsByCountryCity[country][city].push(logData);
            }
            res.json(logsByCountryCity);
        } else {
            res.json(rows);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

router.get("/ping-logs", async (req, res) => {
    try {
        const { timeRange, domain, dateFrom, dateTo } = req.query;

        const { tableName, whereSql, params } = buildTimeFilter({
            type: "ping",
            timeRange,
            dateFrom,
            dateTo,
        });

        const columns = `domain, country, city, rtt_avg, rtt_min, rtt_max, packet_loss, created_at`;

        let query;
        let queryParams;

        if (domain) {
            query = `
                SELECT ${columns}
                FROM ${tableName}
                WHERE ${whereSql} AND city IS NOT NULL AND domain = $${params.length + 1}
                ORDER BY created_at ASC;
            `;
            queryParams = [...params, domain];
        } else {
            query = `
                SELECT ${columns}
                FROM ${tableName}
                WHERE ${whereSql} AND city IS NOT NULL
                ORDER BY created_at ASC;
            `;
            queryParams = params;
        }

        const { rows } = await pool.query(query, queryParams);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

router.get("/locations", (req, res) => {
    res.json(locationGroups);
});

const buildLighthouseTimeFilter = ({ timeRange, dateFrom, dateTo }) => {
    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);

    if (from && to && from < to) {
        const spanMs = to.getTime() - from.getTime();
        const useHourly = spanMs >= HOURLY_THRESHOLD_MS;
        return {
            tableName: useHourly ? "lighthouse_hourly_logs" : "lighthouse_logs",
            whereSql: "created_at >= $1 AND created_at <= $2",
            params: [from.toISOString(), to.toISOString()],
        };
    }

    const cfg = TIME_RANGE_CONFIG[timeRange] ?? TIME_RANGE_CONFIG["3hour"];
    const useHourly = cfg.spanMs >= HOURLY_THRESHOLD_MS;
    return {
        tableName: useHourly ? "lighthouse_hourly_logs" : "lighthouse_logs",
        whereSql: "created_at >= NOW() - $1::interval",
        params: [cfg.interval],
    };
};

router.get("/lighthouse-logs", async (req, res) => {
    try {
        const { timeRange, domain, strategy, dateFrom, dateTo } = req.query;

        const { tableName, whereSql, params } = buildLighthouseTimeFilter({
            timeRange,
            dateFrom,
            dateTo,
        });

        const columns = `domain, url_path, strategy, perf_score, ttfb, lcp, fcp, speed_index, tbt, tti, cls, field_lcp, field_inp, field_cls, field_fcp, field_ttfb, diagnostics, created_at`;

        const conditions = [whereSql];
        const queryParams = [...params];
        if (domain) {
            queryParams.push(domain);
            conditions.push(`domain = $${queryParams.length}`);
        }
        if (strategy) {
            queryParams.push(strategy);
            conditions.push(`strategy = $${queryParams.length}`);
        }

        const query = `
            SELECT ${columns}
            FROM ${tableName}
            WHERE ${conditions.join(" AND ")}
            ORDER BY created_at ASC;
        `;

        const { rows } = await pool.query(query, queryParams);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

router.get("/lighthouse-screenshot", async (req, res) => {
    try {
        const { domain, strategy } = req.query;
        if (!domain || !strategy) {
            return res.status(400).json({ error: "domain and strategy are required" });
        }
        const { rows } = await pool.query(
            `SELECT image, url_path, updated_at FROM lighthouse_screenshots WHERE domain = $1 AND strategy = $2`,
            [domain, strategy]
        );
        res.json(rows[0] ?? null);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

const PROBE_ERROR_CODE = 900;
const SLOW_RESPONSE_MS = 1500;
const SUMMARY_COUNTRIES = ["RU", "UA", "BY"];
const IGNORED_ERROR_CODES = new Set([904, 905]);
const CAPTCHA_STATUS_CODES = new Set([202, 307]);

const isProbeNoise = (r) =>
    IGNORED_ERROR_CODES.has(Number(r.status_code));

const isRelevantResult = (r) => !isProbeNoise(r);

const isProblematicResult = (r) =>
    isRelevantResult(r) &&
    (r.status_code !== 200 ||
        r.total_time === null ||
        (r.total_time !== null && r.total_time > SLOW_RESPONSE_MS));

const getBucketStatus = (results) => {
    const relevant = results.filter(isRelevantResult);
    const probeErrorCount = results.filter(isProbeNoise).length;

    if (probeErrorCount > 0 && relevant.length === 0) return "PROBE_ERROR";

    const captchaCount = relevant.filter(
        (r) => CAPTCHA_STATUS_CODES.has(Number(r.status_code))
    ).length;
    if (captchaCount > 0) return "CAPTCHA";

    const problematic = relevant.filter(isProblematicResult).length;

    if (relevant.length > 0 && problematic === relevant.length) return "DOWN";
    if (problematic >= 3) return "DEGRADED_HIGH";
    if (problematic === 1) return "DEGRADED_LOW";
    if (problematic >= 2) return "DEGRADED_MEDIUM";
    return "UP";
};

const UP_STATUSES = new Set([
    "UP",
    "DEGRADED_LOW",
    "DEGRADED_MEDIUM",
    "DEGRADED_HIGH",
    "CAPTCHA",
]);

router.get("/status-summary", async (req, res) => {
    try {
        const count = Math.min(
            Math.max(parseInt(req.query.count, 10) || 24, 1),
            500
        );

        const { rows } = await pool.query(
            `
            SELECT domain, country, city, status_code, total_time, created_at
            FROM http_logs
            WHERE created_at >= NOW() - $1::interval
              AND city IS NOT NULL
              AND country = ANY($2::text[])
            ORDER BY created_at ASC;
            `,
            ["24 hour", SUMMARY_COUNTRIES]
        );

        const byDomain = {};
        for (const row of rows) {
            if (!byDomain[row.domain]) byDomain[row.domain] = [];
            byDomain[row.domain].push(row);
        }

        const domainData = {};
        for (const [domain, logs] of Object.entries(byDomain)) {
            const buckets = new Map();
            for (const log of logs) {
                const key = new Date(log.created_at)
                    .toISOString()
                    .substring(0, 16);
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(log);
            }

            const orderedKeys = [...buckets.keys()].sort();
            const statuses = orderedKeys.map((k) =>
                getBucketStatus(buckets.get(k))
            );

            const consideredBuckets = statuses.filter((s) => s !== "PROBE_ERROR");
            const upBuckets = consideredBuckets.filter((s) =>
                UP_STATUSES.has(s)
            ).length;
            const uptime24h = consideredBuckets.length
                ? upBuckets / consideredBuckets.length
                : null;

            const validTimes = logs
                .filter(
                    (l) =>
                        Number(l.status_code) < PROBE_ERROR_CODE &&
                        l.total_time !== null
                )
                .map((l) => l.total_time);
            const avgResponseMs = validTimes.length
                ? Math.round(
                      validTimes.reduce((a, b) => a + b, 0) / validTimes.length
                  )
                : null;

            domainData[domain] = {
                current: statuses[statuses.length - 1] ?? "PROBE_ERROR",
                heartbeats: statuses.slice(-count),
                ...(uptime24h !== null && { uptime24h }),
                ...(avgResponseMs !== null && { avgResponseMs }),
            };
        }

        const domains = monitoredDomains
            .filter(({ name }) => domainData[name])
            .map(({ name }) => ({ domain: name, ...domainData[name] }));

        res.json({ updatedAt: new Date().toISOString(), domains });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

const OUTAGE_REASONS = new Set([
    "not_loading",
    "slow",
    "no_media",
    "freezing",
    "auth",
]);

const OUTAGE_WINDOW_HOURS = 24;
const OUTAGE_BUCKET_MS = 30 * 60 * 1000;

router.post("/outage-reports", async (req, res) => {
    try {
        const { reason, reasons, domain } = req.body ?? {};

        const rawReasons = Array.isArray(reasons) ? reasons : [reason];
        const validReasons = [...new Set(rawReasons)].filter((r) =>
            OUTAGE_REASONS.has(r)
        );

        if (validReasons.length === 0) {
            return res.status(400).json({ error: "Invalid reason" });
        }

        const domainValue =
            typeof domain === "string" && domain.trim() !== ""
                ? domain.trim().slice(0, 255)
                : null;

        await pool.query(
            `INSERT INTO outage_reports (domain, reasons) VALUES ($1, $2)`,
            [domainValue, validReasons]
        );

        res.status(201).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

router.get("/outage-reports", async (req, res) => {
    try {
        const now = Date.now();
        const windowMs = OUTAGE_WINDOW_HOURS * 60 * 60 * 1000;
        const end = Math.ceil(now / OUTAGE_BUCKET_MS) * OUTAGE_BUCKET_MS;
        const start = end - windowMs;

        const { rows } = await pool.query(
            `SELECT reasons, created_at
             FROM outage_reports
             WHERE created_at >= NOW() - $1::interval
             ORDER BY created_at ASC;`,
            [`${OUTAGE_WINDOW_HOURS} hour`]
        );

        const bucketCount = Math.round(windowMs / OUTAGE_BUCKET_MS);
        const counts = new Array(bucketCount).fill(0);
        const reasonCounts = {};

        for (const row of rows) {
            const t = new Date(row.created_at).getTime();
            const idx = Math.floor((t - start) / OUTAGE_BUCKET_MS);
            if (idx >= 0 && idx < bucketCount) {
                counts[idx] += 1;
            }
            for (const reason of row.reasons) {
                reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
            }
        }

        const buckets = counts.map((count, i) => ({
            time: new Date(start + i * OUTAGE_BUCKET_MS).toISOString(),
            count,
        }));

        const reasons = Object.entries(reasonCounts)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count);

        const reports = rows
            .map((row) => ({
                time: new Date(row.created_at).toISOString(),
                reasons: row.reasons,
            }))
            .sort((a, b) => new Date(b.time) - new Date(a.time));

        res.json({
            updatedAt: new Date(now).toISOString(),
            total: rows.length,
            buckets,
            reasons,
            reports,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

export default router;
