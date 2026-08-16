import {
    getDomainHealth,
    getDomainLabel,
    isRelevantStatus,
    SLOW_RESPONSE_MS,
} from "../client/src/data/constants.ts";

const WAF_DOMAIN = "waf.valtrix.org";
const API_DOMAIN = "api.yani.tv";
const SITE_DOMAINS = [
    "old.yummyani.me",
    "old.yummy-ani.me",
    "ru.yummyani.me",
    "ru.yummy-ani.me",
];
const ZONES = ["yummy-ani.me", "yummyani.me"];
const OK_CODES = [200, 202];
const MAX_LISTED_DOMAINS = 6;
const CAPTION_LIMIT = 1024;
const DIVIDER = "━━━━━━━━━━━━━━";

const ERROR_CLASSES = [
    { label: "таймауты", match: (code) => code === 902 || code === 908 },
    { label: "DNS не резолвится", match: (code) => code === 903 },
    { label: "соединение отклоняется", match: (code) => code === 906 },
    { label: "ошибка TLS", match: (code) => code === 907 },
    { label: "проба не прошла", match: (code) => code === 901 },
    {
        label: "ошибки сервера (5xx)",
        match: (code) => code >= 500 && code < 600,
    },
    {
        label: "блокировка (403/429)",
        match: (code) => code === 403 || code === 429,
    },
    { label: "ответы 4xx", match: (code) => code >= 400 && code < 500 },
    { label: "редиректы (3xx)", match: (code) => code >= 300 && code < 400 },
];

const CAUSES = {
    ddos: {
        emoji: "⚡",
        title: "Серьёзная DDoS-атака",
        detail: "Недоступны все домены вместе с узлом защиты — трафик не доходит",
    },
    origin: {
        emoji: "🧨",
        title: "Отказ origin-инфраструктуры",
        detail: "Защита отвечает, источник — нет: бэкенд, БД или сеть ЦОД.",
    },
    waf: {
        emoji: "🛡",
        title: "Сбой узла защиты",
        detail: "Проблема на waf.valtrix.org — фильтрация или маршрутизация трафика.",
    },
    api: {
        emoji: "🔌",
        title: "Сбой API-бэкенда",
        detail: "Страницы открываются, данные не приходят: api.yani.tv не отвечает.",
    },
    zone: {
        emoji: "🌐",
        title: "Проблема доменной зоны",
        detail: "Упала целиком одна зона — DNS/NS, сертификат или блокировка зеркала.",
    },
    frontend: {
        emoji: "🖥",
        title: "Сбой фронтенда",
        detail: "Затронута одна версия сайта",
    },
    partial: {
        emoji: "📉",
        title: "Точечная деградация",
        detail: "Отвечает часть доменов и локаций — сбой не охватывает всю инфраструктуру.",
    },
};

const isFailure = (log) =>
    !OK_CODES.includes(Number(log.status_code)) ||
    Boolean(log.total_time && log.total_time > SLOW_RESPONSE_MS);

const classifyFailure = (log) => {
    const code = Number(log.status_code);
    if (OK_CODES.includes(code)) return "медленные ответы";
    const found = ERROR_CLASSES.find((entry) => entry.match(code));
    return found ? found.label : `код ${code}`;
};

const dominant = (values) => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best = null;
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return { value: best, count: bestCount };
};

const zoneOf = (domain) => ZONES.find((zone) => domain.endsWith(zone)) ?? null;

const pickCause = (names) => {
    const has = (domain) => names.has(domain);
    const allSites = SITE_DOMAINS.every(has);

    if (allSites && has(WAF_DOMAIN)) return { key: "ddos", ...CAUSES.ddos };
    if (allSites) return { key: "origin", ...CAUSES.origin };
    if (names.size === 1 && has(WAF_DOMAIN))
        return { key: "waf", ...CAUSES.waf };
    if (names.size === 1 && has(API_DOMAIN))
        return { key: "api", ...CAUSES.api };

    const siteNames = [...names].filter((name) => SITE_DOMAINS.includes(name));
    if (siteNames.length === names.size && siteNames.length > 1) {
        for (const zone of ZONES) {
            const zoneDomains = SITE_DOMAINS.filter((d) => zoneOf(d) === zone);
            if (
                siteNames.length === zoneDomains.length &&
                zoneDomains.every(has)
            ) {
                return { key: "zone", ...CAUSES.zone };
            }
        }
        for (const prefix of ["old.", "ru."]) {
            const versionDomains = SITE_DOMAINS.filter((d) =>
                d.startsWith(prefix)
            );
            if (
                siteNames.length === versionDomains.length &&
                versionDomains.every(has)
            ) {
                return { key: "frontend", ...CAUSES.frontend };
            }
        }
    }

    return { key: "partial", ...CAUSES.partial };
};

export const diagnose = (logs) => {
    const relevant = logs.filter(
        (log) =>
            log.status_code !== undefined && isRelevantStatus(log.status_code)
    );

    const byDomain = new Map();
    for (const log of logs) {
        const domain = log.domain ?? "unknown";
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(log);
    }

    const affected = [];
    for (const [domain, domainLogs] of byDomain) {
        if (getDomainHealth(domainLogs) !== "critical") continue;
        const domainRelevant = domainLogs.filter(
            (log) =>
                log.status_code !== undefined &&
                isRelevantStatus(log.status_code)
        );
        const failures = domainRelevant.filter(isFailure);
        affected.push({
            domain,
            label: getDomainLabel(domain),
            failRate: domainRelevant.length
                ? failures.length / domainRelevant.length
                : 0,
            reason: dominant(failures.map(classifyFailure)).value ?? "сбой",
        });
    }
    affected.sort((a, b) => b.failRate - a.failRate);

    const failures = relevant.filter(isFailure);
    const failuresByCountry = dominant(
        failures.map((log) => log.country).filter(Boolean)
    );
    const countries = [
        ...new Set(relevant.map((log) => log.country).filter(Boolean)),
    ];
    const localizedTo =
        countries.length > 1 &&
        failures.length > 0 &&
        failuresByCountry.count / failures.length >= 0.85
            ? failuresByCountry.value
            : null;

    return {
        affected,
        cause: pickCause(new Set(affected.map((entry) => entry.domain))),
        stats: {
            measurements: relevant.length,
            failRate: relevant.length ? failures.length / relevant.length : 0,
            countries,
            localizedTo,
        },
    };
};

const moscow = (date, withDate) =>
    date
        .toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
            ...(withDate && { day: "2-digit", month: "2-digit" }),
            hour: "2-digit",
            minute: "2-digit",
        })
        .replace(", ", " · ");

export const formatDuration = (ms) => {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
};

const percent = (value) => `${Math.round(value * 100)}%`;

export const buildAlert = (diagnosis, startedAt) => {
    const { affected, cause, stats } = diagnosis;

    const listed = affected.slice(0, MAX_LISTED_DOMAINS);
    const hidden = affected.length - listed.length;
    const lines = listed.map(
        (entry) =>
            `• <code>${entry.label}</code> — ${percent(entry.failRate)} сбоев · ${entry.reason}`
    );
    if (hidden > 0) lines.push(`• и ещё ${hidden}`);

    const geo = stats.localizedTo
        ? `\n<i>Сбои сосредоточены в ${stats.localizedTo} — вероятна блокировка или маршрутизация у операторов.</i>`
        : "";

    const caption = [
        `🔴 <b>Возникли неполадки</b>`,
        `<i>${moscow(startedAt, true)} МСК · окно 3 часа</i>`,
        ``,
        `<b>Затронуто</b>`,
        lines.join("\n") || "• нет данных",
        ``,
        `${cause.emoji} <b>${cause.title}</b>`,
        `<i>${cause.detail}</i>${geo}`,
        ``,
        `<i>${stats.measurements} замеров · ${percent(stats.failRate)} сбойных · ${stats.countries.join(", ")}</i>`,
    ].join("\n");

    return caption.slice(0, CAPTION_LIMIT);
};

export const withUpdate = (alert, update) => {
    const header =
        update.kind === "resolved"
            ? `✅ <b>Восстановлено</b> · ${moscow(update.at, false)} МСК`
            : `🕒 <b>Обновление</b> · ${moscow(update.at, false)} МСК`;
    const body =
        update.kind === "resolved"
            ? `Инцидент длился ${formatDuration(update.durationMs)}`
            : `Длится ${formatDuration(update.durationMs)} · ${update.changed ? "состав сбоя изменился" : "сбой сохраняется"}`;

    const block = `\n\n${DIVIDER}\n${header}\n${body}`;
    return `${alert.slice(0, CAPTION_LIMIT - block.length)}${block}`;
};

if (import.meta.main) {
    const { default: assert } = await import("node:assert/strict");

    const start = new Date("2026-08-16T10:00:00Z");
    const logsFor = (domain, { failing, code = 502, country = "RU" }) =>
        Array.from({ length: 10 }, (_, i) => ({
            domain,
            country,
            city: "Moscow",
            created_at: new Date(start.getTime() + i * 60000).toISOString(),
            status_code: failing ? code : 200,
            total_time: 300,
        }));

    const build = (downDomains, options = {}) =>
        [...SITE_DOMAINS, API_DOMAIN, WAF_DOMAIN].flatMap((domain) =>
            logsFor(domain, {
                failing: downDomains.includes(domain),
                ...options,
            })
        );

    const causeOf = (downDomains, options) =>
        diagnose(build(downDomains, options)).cause.key;

    assert.equal(causeOf([...SITE_DOMAINS, API_DOMAIN, WAF_DOMAIN]), "ddos");
    assert.equal(causeOf([...SITE_DOMAINS, API_DOMAIN]), "origin");
    assert.equal(causeOf([WAF_DOMAIN]), "waf");
    assert.equal(causeOf([API_DOMAIN]), "api");
    assert.equal(causeOf(["old.yummy-ani.me", "ru.yummy-ani.me"]), "zone");
    assert.equal(causeOf(["old.yummyani.me", "old.yummy-ani.me"]), "frontend");
    assert.equal(causeOf(["ru.yummyani.me"]), "partial");
    assert.equal(causeOf([]), "partial");

    const timeouts = diagnose(build([API_DOMAIN], { code: 902 }));
    assert.equal(timeouts.affected[0].reason, "таймауты");
    assert.equal(timeouts.affected[0].failRate, 1);

    const slow = diagnose(
        [...SITE_DOMAINS, API_DOMAIN, WAF_DOMAIN].flatMap((domain) =>
            logsFor(domain, { failing: false }).map((log) =>
                log.domain === WAF_DOMAIN ? { ...log, total_time: 5000 } : log
            )
        )
    );
    assert.equal(slow.cause.key, "waf");
    assert.equal(slow.affected[0].reason, "медленные ответы");

    const mixedGeo = [
        ...build([API_DOMAIN]),
        ...logsFor("ru.yummyani.me", { failing: false, country: "UA" }),
    ];
    assert.equal(diagnose(mixedGeo).stats.localizedTo, "RU");

    const alert = buildAlert(
        diagnose(build([...SITE_DOMAINS, WAF_DOMAIN])),
        start
    );
    assert.ok(alert.includes("Серьёзная DDoS-атака"));
    assert.ok(alert.length <= CAPTION_LIMIT);

    const resolved = withUpdate(alert, {
        kind: "resolved",
        at: new Date(start.getTime() + 49 * 60000),
        durationMs: 49 * 60000,
    });
    assert.ok(resolved.includes("Восстановлено"));
    assert.ok(resolved.includes("49 мин"));
    assert.ok(resolved.length <= CAPTION_LIMIT);

    const long = withUpdate("x".repeat(CAPTION_LIMIT), {
        kind: "ongoing",
        at: start,
        durationMs: 90 * 60000,
        changed: true,
    });
    assert.ok(long.length <= CAPTION_LIMIT);
    assert.ok(long.includes("1 ч 30 мин"));

    console.log("diagnose: все проверки пройдены");
}
