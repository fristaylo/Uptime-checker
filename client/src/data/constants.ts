export const SITE_URL = "https://yummystatus.me";

export const countries = [
    { code: "RU", name: "Россия" },
    { code: "UA", name: "Украина" },
    { code: "KZ", name: "Казахстан" },
    { code: "BY", name: "Беларусь" },
    { code: "DE", name: "Германия" },
    { code: "KG", name: "Кыргызстан" },
    { code: "PL", name: "Польша" },
    { code: "LV", name: "Латвия" },
    { code: "LT", name: "Литва" },
    { code: "EE", name: "Эстония" },
    { code: "US", name: "США" },
    { code: "NL", name: "Нидерланды" },
    { code: "GB", name: "Великобритания" },
    { code: "MD", name: "Молдова" },
    { code: "CZ", name: "Чехия" },
    { code: "GE", name: "Грузия" },
    { code: "AM", name: "Армения" },
];

export const domainGroups = [
    {
        title: "Старый сайт",
        domains: [
            { value: "old.yummyani.me", label: "old.yummyani.me" },
            { value: "old.yummy-ani.me", label: "old.yummy-ani.me" },
        ],
    },
    {
        title: "Новый сайт",
        domains: [
            { value: "ru.yummyani.me", label: "new.yummyani.me" },
            { value: "ru.yummy-ani.me", label: "new.yummy-ani.me" },
        ],
    },
    {
        title: "Служебные сервисы",
        domains: [
            { value: "api.yani.tv", label: "API" },
            { value: "waf.valtrix.org", label: "Защита" },
        ],
    },
];

export const domains = domainGroups.flatMap((group) =>
    group.domains.map((entry) => entry.value)
);

const domainLabelMap: { [value: string]: string } = Object.fromEntries(
    domainGroups.flatMap((group) =>
        group.domains.map((entry) => [entry.value, entry.label])
    )
);

export const getDomainLabel = (value: string): string =>
    domainLabelMap[value] ?? value;

export const cityTranslations: { [key: string]: string } = {
    Moscow: "Москва",
    "Saint Petersburg": "Санкт-Петербург",
    Kyiv: "Киев",
    Lviv: "Львов",
    Odesa: "Одесса",
    Almaty: "Алматы",
    Minsk: "Минск",
    Berlin: "Берлин",
    Dusseldorf: "Дюссельдорф",
    Bishkek: "Бишкек",
    Warsaw: "Варшава",
    Krakow: "Краков",
    Riga: "Рига",
    Vilnius: "Вильнюс",
    Siauliai: "Шяуляй",
    Tallinn: "Таллин",
    "New York": "Нью-Йорк",
    "Los Angeles": "Лос-Анджелес",
    Amsterdam: "Амстердам",
    Utrecht: "Утрехт",
    London: "Лондон",
    Chisinau: "Кишинёв",
    Prague: "Прага",
    Brno: "Брно",
    Tbilisi: "Тбилиси",
    Yerevan: "Ереван",
    Novosibirsk: "Новосибирск",
    Aktau: "Актау",
};

export const PROBE_ERROR_CODE = 900;
export const SLOW_RESPONSE_MS = 1500;
export const CHART_SPIKE_MS = 2500;
export const IGNORED_ERROR_CODES = new Set([904, 905]);
export const CAPTCHA_STATUS_CODES = new Set([202, 307]);

export const isProbeNoise = (statusCode: number | null | undefined): boolean =>
    IGNORED_ERROR_CODES.has(Number(statusCode));

export const isRelevantStatus = (statusCode: number | null | undefined): boolean =>
    !isProbeNoise(statusCode);

export const isBareView = (): boolean =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("bare");

export type DomainHealth = "stable" | "warning" | "critical";

export const HEALTH_LABEL: Record<DomainHealth, string> = {
    stable: "Все работает стабильно",
    warning: "Возможные неполадки",
    critical: "Возникли неполадки",
};

export const getDomainHealth = (
    logs: { created_at: string; status_code?: number; total_time?: number }[]
): DomainHealth => {
    if (logs.length === 0) return "stable";

    const okCodes = [200, 202];
    const isErrorLog = (log: { status_code?: number; total_time?: number }) =>
        !okCodes.includes(log.status_code as number) ||
        Boolean(log.total_time && log.total_time > SLOW_RESPONSE_MS);

    const relevantLogs = logs.filter(
        (log) => log.status_code !== undefined && isRelevantStatus(log.status_code)
    );
    if (relevantLogs.length === 0) return "stable";

    const errorRate =
        (relevantLogs.filter(isErrorLog).length / relevantLogs.length) * 100;

    const sortedLogs = [...relevantLogs].sort(
        (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const lastLogs = sortedLogs.slice(-4);
    const last4Errors = lastLogs.length >= 4 && lastLogs.every(isErrorLog);
    const last2Errors =
        lastLogs.length >= 2 && lastLogs.slice(-2).every(isErrorLog);

    if (errorRate >= 20 || last4Errors) return "critical";
    if (errorRate >= 5 || last2Errors) return "warning";
    return "stable";
};

export const getGlobalHealth = (
    logs: { domain?: string; created_at: string; status_code?: number; total_time?: number }[]
): DomainHealth => {
    const domainNames = [...new Set(logs.map((l) => l.domain).filter(Boolean))];
    let worst: DomainHealth = "stable";
    for (const d of domainNames) {
        const health = getDomainHealth(logs.filter((l) => l.domain === d));
        if (health === "critical") return "critical";
        if (health === "warning") worst = "warning";
    }
    return worst;
};

export type BucketColor =
    | "green"
    | "darkGreen"
    | "yellow"
    | "orange"
    | "red"
    | "grey"
    | "blue";

interface BucketResult {
    status_code: number | null;
    total_time: number | null;
}

const isBucketResultProblematic = (r: BucketResult): boolean =>
    isRelevantStatus(r.status_code) &&
    (r.status_code !== 200 ||
        r.total_time === null ||
        r.total_time > SLOW_RESPONSE_MS);

export const getBucketColor = (results: BucketResult[]): BucketColor => {
    const relevant = results.filter((r) => isRelevantStatus(r.status_code));
    const probeErrorCount = results.filter((r) => isProbeNoise(r.status_code)).length;

    if (probeErrorCount > 0 && relevant.length === 0) return "grey";

    const captchaCount = relevant.filter((r) =>
        CAPTCHA_STATUS_CODES.has(Number(r.status_code))
    ).length;
    if (captchaCount > 0) return "blue";

    const problematic = relevant.filter(isBucketResultProblematic).length;

    if (relevant.length > 0 && problematic === relevant.length) return "red";
    if (problematic >= 3) return "orange";
    if (problematic === 1) return "darkGreen";
    if (problematic >= 2) return "yellow";
    return "green";
};

export const getBucketColorCounts = (
    logs: { domain?: string; created_at: string; status_code?: number; total_time?: number }[]
): Record<BucketColor, number> => {
    const counts: Record<BucketColor, number> = {
        green: 0,
        darkGreen: 0,
        yellow: 0,
        orange: 0,
        red: 0,
        grey: 0,
        blue: 0,
    };

    const buckets = new Map<string, BucketResult[]>();
    for (const log of logs) {
        const key = `${log.domain ?? ""}|${log.created_at.substring(0, 16)}`;
        const bucket = buckets.get(key);
        const result: BucketResult = {
            status_code: log.status_code ?? null,
            total_time: log.total_time ?? null,
        };
        if (bucket) {
            bucket.push(result);
        } else {
            buckets.set(key, [result]);
        }
    }

    for (const results of buckets.values()) {
        counts[getBucketColor(results)] += 1;
    }

    return counts;
};

export const CHART_COLORS = [
    "#ff6666",
    "#36a2eb",
    "#ffce56",
    "#4bc0c0",
    "#9966ff",
    "#ff9f40",
    "#E7E9ED",
    "#A8D08D", 
    "#C08497", 
    "#9D7CA0", 
    "#7EC0EE", 
]
