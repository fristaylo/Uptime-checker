import dotenv from "dotenv";
dotenv.config();
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
    host: "db",
    port: 5432,
    database: "yummystatus",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

export const createHttpTable = async () => {
    try {
        const httpLogsQuery = `
    CREATE TABLE IF NOT EXISTS http_logs (
      id SERIAL PRIMARY KEY,
      probe_id VARCHAR(255),
      domain VARCHAR(255),
      country VARCHAR(2),
      city VARCHAR(255),
      asn INT,
      network VARCHAR(255),
      status_code INT,
      total_time FLOAT,
      download_time FLOAT,
      first_byte_time FLOAT,
      dns_time FLOAT,
      tls_time FLOAT,
      tcp_time FLOAT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
        await pool.query(httpLogsQuery);
        console.log('Table "http_logs" created or already exists.');

        const hourlyLogsQuery = `
    CREATE TABLE IF NOT EXISTS http_hourly_logs (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255),
      country VARCHAR(2),
      city VARCHAR(255),
      status_code INT,
      total_time FLOAT,
      download_time FLOAT,
      first_byte_time FLOAT,
      dns_time FLOAT,
      tls_time FLOAT,
      tcp_time FLOAT,
      created_at TIMESTAMP
    );
  `;
        await pool.query(hourlyLogsQuery);
        console.log('Table "http_hourly_logs" created or already exists.');

        await pool.query(`ALTER TABLE http_logs ADD COLUMN IF NOT EXISTS server_timing JSONB;`);
        await pool.query(`ALTER TABLE http_hourly_logs ADD COLUMN IF NOT EXISTS server_timing JSONB;`);

        await pool.query(`ALTER TABLE http_logs ADD COLUMN IF NOT EXISTS failure_reason TEXT;`);

        const pingLogsQuery = `
    CREATE TABLE IF NOT EXISTS ping_logs (
      id SERIAL PRIMARY KEY,
      probe_id VARCHAR(255),
      domain VARCHAR(255),
      country VARCHAR(2),
      city VARCHAR(255),
      asn INT,
      network VARCHAR(255),
      rtt_min FLOAT,
      rtt_avg FLOAT,
      rtt_max FLOAT,
      packet_loss FLOAT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
        await pool.query(pingLogsQuery);
        console.log('Table "ping_logs" created or already exists.');

        const pingHourlyLogsQuery = `
    CREATE TABLE IF NOT EXISTS ping_hourly_logs (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255),
      country VARCHAR(2),
      city VARCHAR(255),
      rtt_min FLOAT,
      rtt_avg FLOAT,
      rtt_max FLOAT,
      packet_loss FLOAT,
      created_at TIMESTAMP
    );
  `;
        await pool.query(pingHourlyLogsQuery);
        console.log('Table "ping_hourly_logs" created or already exists.');

        const lighthouseColumns = `
      perf_score   FLOAT,
      ttfb         FLOAT,
      lcp          FLOAT,
      fcp          FLOAT,
      speed_index  FLOAT,
      tbt          FLOAT,
      tti          FLOAT,
      cls          FLOAT,
      field_lcp    FLOAT,
      field_inp    FLOAT,
      field_cls    FLOAT,
      field_fcp    FLOAT,
      field_ttfb   FLOAT,
      diagnostics  JSONB
    `;

        const lighthouseLogsQuery = `
    CREATE TABLE IF NOT EXISTS lighthouse_logs (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255),
      url_path VARCHAR(512),
      strategy VARCHAR(16),
      ${lighthouseColumns},
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
        await pool.query(lighthouseLogsQuery);
        console.log('Table "lighthouse_logs" created or already exists.');

        const lighthouseHourlyLogsQuery = `
    CREATE TABLE IF NOT EXISTS lighthouse_hourly_logs (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255),
      url_path VARCHAR(512),
      strategy VARCHAR(16),
      ${lighthouseColumns},
      created_at TIMESTAMP
    );
  `;
        await pool.query(lighthouseHourlyLogsQuery);
        console.log('Table "lighthouse_hourly_logs" created or already exists.');

        const lighthouseScreenshotsQuery = `
    CREATE TABLE IF NOT EXISTS lighthouse_screenshots (
      domain VARCHAR(255),
      strategy VARCHAR(16),
      url_path VARCHAR(512),
      image TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (domain, strategy)
    );
  `;
        await pool.query(lighthouseScreenshotsQuery);
        console.log('Table "lighthouse_screenshots" created or already exists.');

        const outageReportsQuery = `
    CREATE TABLE IF NOT EXISTS outage_reports (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255),
      reasons VARCHAR(64)[] NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
        await pool.query(outageReportsQuery);
        await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outage_reports' AND column_name = 'reason'
      ) THEN
        ALTER TABLE outage_reports ADD COLUMN IF NOT EXISTS reasons VARCHAR(64)[];
        UPDATE outage_reports SET reasons = ARRAY[reason] WHERE reasons IS NULL;
        ALTER TABLE outage_reports ALTER COLUMN reasons SET NOT NULL;
        ALTER TABLE outage_reports DROP COLUMN reason;
      END IF;
    END $$;
        `);
        await pool.query(
            `CREATE INDEX IF NOT EXISTS idx_outage_reports_created_at ON outage_reports (created_at);`
        );
        console.log('Table "outage_reports" created or already exists.');

        const indexStatements = [
            `CREATE INDEX IF NOT EXISTS idx_http_logs_domain_created_at ON http_logs (domain, created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_http_logs_created_at ON http_logs (created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_http_logs_domain_loc_created_at ON http_logs (domain, country, city, created_at DESC);`,
            `CREATE INDEX IF NOT EXISTS idx_http_hourly_logs_domain_created_at ON http_hourly_logs (domain, created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_http_hourly_logs_created_at ON http_hourly_logs (created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_ping_logs_domain_created_at ON ping_logs (domain, created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_ping_logs_created_at ON ping_logs (created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_ping_hourly_logs_domain_created_at ON ping_hourly_logs (domain, created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_ping_hourly_logs_created_at ON ping_hourly_logs (created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_lighthouse_logs_domain_strategy_created_at ON lighthouse_logs (domain, strategy, created_at);`,
            `CREATE INDEX IF NOT EXISTS idx_lighthouse_hourly_logs_domain_strategy_created_at ON lighthouse_hourly_logs (domain, strategy, created_at);`,
        ];
        for (const statement of indexStatements) {
            await pool.query(statement);
        }
        await pool.query(`ANALYZE http_logs, http_hourly_logs, ping_logs, ping_hourly_logs, lighthouse_logs, lighthouse_hourly_logs;`);
        console.log("Log table indexes created or already exist.");

    } catch (err) {
        console.error("Error creating table", err);
    }
};

export default pool;
