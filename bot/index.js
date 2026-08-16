process.env.TZ = "UTC";

import dotenv from "dotenv";

dotenv.config();

import { readFileSync, rmSync, writeFileSync } from "fs";
import { getGlobalHealth } from "../client/src/data/constants.ts";
import {
    buildAlert,
    diagnose,
    formatDuration,
    withUpdate,
} from "./diagnose.js";

const TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const API_URL = process.env.API_URL ?? "http://app:3000";
const SITE_URL = process.env.SITE_URL ?? "https://yummystatus.me";
const SCREENSHOT_URL =
    process.env.SCREENSHOT_URL ??
    "https://image.thum.io/get/width/1280/crop/600/refresh/60/wait/12/noanimate/{url}";
const SCREENSHOT_TARGET =
    process.env.SCREENSHOT_TARGET ?? `${SITE_URL}/?bare=1`;
const INTERVAL_MS = Number(process.env.BOT_INTERVAL_MS ?? 2 * 60 * 1000);
const UPDATE_INTERVAL_MS = Number(
    process.env.BOT_UPDATE_INTERVAL_MS ?? 15 * 60 * 1000
);
const RECOVERY_CHECKS = Number(process.env.BOT_RECOVERY_CHECKS ?? 2);
const STATE_FILE =
    process.env.BOT_STATE_FILE ?? new URL("./.state.json", import.meta.url);
const DRY_RUN = process.env.BOT_DRY_RUN === "1";
const FORCE_ALERT = process.env.BOT_FORCE_ALERT === "1";
const ALLOWED_COUNTRIES = ["RU", "UA", "BY"];
const SCREENSHOT_TIMEOUT_MS = 90 * 1000;

if (!DRY_RUN && (!TOKEN || !CHAT_ID)) {
    console.error("Нужны TG_BOT_TOKEN и TG_CHAT_ID");
    process.exit(1);
}

const readState = () => {
    try {
        return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
        return null;
    }
};

const writeState = (state) => {
    if (state) writeFileSync(STATE_FILE, JSON.stringify(state));
    else rmSync(STATE_FILE, { force: true });
};

const telegram = async (method, body) => {
    const init =
        body instanceof FormData
            ? { method: "POST", body }
            : {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
              };
    const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/${method}`,
        init
    );
    const data = await response.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
};

const fetchLogs = async () => {
    const response = await fetch(`${API_URL}/http-logs?timeRange=3hour`, {
        signal: AbortSignal.timeout(30 * 1000),
    });
    if (!response.ok) throw new Error(`http-logs: ${response.status}`);
    const logs = await response.json();
    return logs.filter((log) => ALLOWED_COUNTRIES.includes(log.country));
};

const fetchScreenshot = async () => {
    try {
        const response = await fetch(
            SCREENSHOT_URL.replace("{url}", SCREENSHOT_TARGET),
            {
                signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
            }
        );
        if (!response.ok) throw new Error(`screenshot: ${response.status}`);
        const image = new Uint8Array(await response.arrayBuffer());
        return image.byteLength > 0 ? image : null;
    } catch (error) {
        console.error("Скриншот не получен:", error.message);
        return null;
    }
};

const sendAlert = async (caption) => {
    const image = await fetchScreenshot();

    if (DRY_RUN) {
        console.log(
            `--- caption (${caption.length} симв., фото: ${Boolean(image)}) ---`
        );
        console.log(caption);
        return { messageId: 0, hasPhoto: Boolean(image) };
    }

    if (image) {
        const form = new FormData();
        form.set("chat_id", CHAT_ID);
        form.set("caption", caption);
        form.set("parse_mode", "HTML");
        form.set(
            "photo",
            new Blob([image], { type: "image/png" }),
            "status.png"
        );
        const message = await telegram("sendPhoto", form);
        return { messageId: message.message_id, hasPhoto: true };
    }

    const message = await telegram("sendMessage", {
        chat_id: CHAT_ID,
        text: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
    });
    return { messageId: message.message_id, hasPhoto: false };
};

const editAlert = async (state, caption) => {
    const image = state.hasPhoto ? await fetchScreenshot() : null;

    if (DRY_RUN) {
        console.log(
            `--- update (${caption.length} симв., фото: ${Boolean(image)}) ---`
        );
        console.log(caption);
        return;
    }

    if (image) {
        const form = new FormData();
        form.set("chat_id", CHAT_ID);
        form.set("message_id", String(state.messageId));
        form.set(
            "media",
            JSON.stringify({
                type: "photo",
                media: "attach://photo",
                caption,
                parse_mode: "HTML",
            })
        );
        form.set(
            "photo",
            new Blob([image], { type: "image/png" }),
            "status.png"
        );
        await telegram("editMessageMedia", form);
        return;
    }

    if (state.hasPhoto) {
        await telegram("editMessageCaption", {
            chat_id: CHAT_ID,
            message_id: state.messageId,
            caption,
            parse_mode: "HTML",
        });
        return;
    }

    await telegram("editMessageText", {
        chat_id: CHAT_ID,
        message_id: state.messageId,
        text: caption,
        parse_mode: "HTML",
        disable_web_page_preview: true,
    });
};

const signatureOf = (diagnosis) =>
    `${diagnosis.cause.key}|${diagnosis.affected
        .map((entry) => entry.domain)
        .sort()
        .join(",")}`;

const tick = async () => {
    const logs = await fetchLogs();
    const health = FORCE_ALERT ? "critical" : getGlobalHealth(logs);
    const now = new Date();
    const state = readState();

    if (health === "critical") {
        const diagnosis = diagnose(logs);
        const signature = signatureOf(diagnosis);

        if (!state) {
            const alert = buildAlert(diagnosis, now);
            const sent = await sendAlert(alert);
            writeState({
                ...sent,
                startedAt: now.toISOString(),
                updatedAt: now.toISOString(),
                signature,
                alert,
                okChecks: 0,
            });
            console.log(`Инцидент открыт: ${diagnosis.cause.title}`);
            return;
        }

        const changed = signature !== state.signature;
        const stale =
            now.getTime() - new Date(state.updatedAt).getTime() >=
            UPDATE_INTERVAL_MS;
        if (!changed && !stale) {
            if (state.okChecks) writeState({ ...state, okChecks: 0 });
            return;
        }

        const startedAt = new Date(state.startedAt);
        const alert = buildAlert(diagnosis, startedAt);
        await editAlert(
            state,
            withUpdate(alert, {
                kind: "ongoing",
                at: now,
                durationMs: now.getTime() - startedAt.getTime(),
                changed,
            })
        );
        writeState({
            ...state,
            updatedAt: now.toISOString(),
            signature,
            alert,
            okChecks: 0,
        });
        console.log(`Инцидент обновлён: ${diagnosis.cause.title}`);
        return;
    }

    if (!state) return;

    const okChecks = (state.okChecks ?? 0) + 1;
    if (okChecks < RECOVERY_CHECKS) {
        writeState({ ...state, okChecks });
        return;
    }

    const durationMs = now.getTime() - new Date(state.startedAt).getTime();
    await editAlert(
        state,
        withUpdate(state.alert, { kind: "resolved", at: now, durationMs })
    );
    writeState(null);
    console.log(`Инцидент закрыт, длительность: ${formatDuration(durationMs)}`);
};

const run = () =>
    tick().catch((error) => console.error("Цикл упал:", error.message));

console.log(
    `Бот запущен: ${API_URL}, интервал ${INTERVAL_MS / 1000} c${DRY_RUN ? ", dry-run" : ""}`
);
run();
setInterval(run, INTERVAL_MS);
