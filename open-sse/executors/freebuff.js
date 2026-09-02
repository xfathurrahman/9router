// ── FREEBUFF-PATCH (safe to revert wholesale) ──────────────────────────────
// FreebuffExecutor — talks to https://www.codebuff.com/api/v1 (Freebuff/Codebuff
// free tier). The upstream is NOT plain OpenAI: every chat needs
//   1. a free session   POST /api/v1/freebuff/session  -> instanceId (~1h)
//   2. an agent run     POST /api/v1/agent-runs {action:START} -> runId
//   3. the chat POST carrying a "CLI envelope" (codebuff_metadata) or the
//      server rejects it (400 no runId / 402 out of credits / 403
//      free_mode_cli_required). Stream-only; SSE is re-aggregated by 9router
//      for non-streaming clients.
// Wire format reverse-engineered from the Freebuff CLI (see also
// bot/freebuff-9router/adapter.py in the cbthree workspace).
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const API_BASE = "https://www.codebuff.com";
const CLI_UA = "Freebuff-CLI/0.0.166";
const CHAT_URL = `${API_BASE}/api/v1/chat/completions`;
const SESSION_URL = `${API_BASE}/api/v1/freebuff/session`;
const RUNS_URL = `${API_BASE}/api/v1/agent-runs`;
const DEFAULT_MODEL = "mimo/mimo-v2.5";

// FREEBUFF-PATCH notes: upstream allows ONE live session per account with
// the model fixed per session (409 model_locked). The executor ends and
// re-mints the session when the requested model changes, and retries once
// on 428/409/429 (session races / capacity).

// Anti-abuse gate: first system message must carry the "Buffy" identity marker
// (else 403 free_mode_cli_required).
export const FREEBUFF_SYSTEM_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent " +
  "behind the product, Freebuff, a tool where users can chat with you " +
  "to code with AI for free.";

// Free-mode root agent per model — REVERSE ENGINEERED from the freebuff CLI
// binary 0.0.166 (~/.config/manicode/freebuff), constants block s1():
//   UM="deepseek/deepseek-v4-flash" -> PaA.UM="base2-free-deepseek-flash"
//   _P="minimax/minimax-m3"         -> "base2-free-minimax-m3"
//   bU="openai/gpt-5.6-luna"        -> "base2-free-luna"
//   ha="upstage/solar-pro4"         -> "base2-free-solar-pro4"
//   lU="deepseek/deepseek-v4-pro"   -> "base2-free-deepseek"
//   S8="z-ai/glm-5.2"               -> "base2-free-glm"
//   fP="z-ai/glm-5.3-flash"         -> "base2-free-glm-5-3-flash"
//   xg="crof/kimi-k3-eco"           -> "base2-free-kimi-k3-eco"
//   o2="anthropic/claude-fable-5"   -> "base2-free-fable"
//   $9="stealth/ox-alpha"           -> "base2-free-ox-alpha"
//   Kg="meta/muse-spark-1.2-contributor" -> "base2-free-muse-spark"
//   IU="mimo/mimo-v2.5" (default)   -> "base2-free-mimo"
// NOTE: old adapter.py used "base2-free" for mimo — upstream now rejects
// unknown agents with 404 "No endpoints found for <model>".
const MODEL_AGENT = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.5-pro": "base2-free-mimo",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "z-ai/glm-5.2": "base2-free-glm",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "stealth/ox-alpha": "base2-free-ox-alpha",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};
const DEFAULT_AGENT = "base2-free-mimo";

// Per-token session cache — upstream allows ONE active session per account
// (409 model_locked proves it). Value: { instanceId, expiresAt(ms), model }.
// Requesting a different model ends the current session and re-mints (the
// official CLI does exactly this on model_locked).
const sessionCache = new Map();
const SESSION_EXPIRY_BUFFER_MS = 60_000;
const SESSION_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomId(len) {
  let id = "";
  for (let i = 0; i < len; i++) id += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
  return id;
}

function resetSession(authToken) {
  sessionCache.delete(authToken);
}

async function deleteSession(authToken, proxyOptions) {
  // Best-effort: end the account's active session (CLI: x5("DELETE", token)).
  try {
    await proxyAwareFetch(SESSION_URL, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}`, "User-Agent": CLI_UA },
    }, proxyOptions);
  } catch { /* ignore */ }
}

async function mintSession(authToken, model, proxyOptions, log) {
  const body = {
    provider: "gravity",
    messages: [],
    sessionId: "ad-" + randomId(10),
    device: { os: "linux", timezone: "UTC", locale: "en-US" },
    surface: "cli",
  };
  const doMint = () => proxyAwareFetch(SESSION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CLI_UA,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  }, proxyOptions);

  let resp = await doMint();
  // 409 model_locked / model_unavailable: the account's single session slot is
  // held by another model (or the model is out of capacity). End the session
  // and re-mint once — same recovery the CLI session loop performs.
  if (resp.status === 409) {
    const err = await resp.json().catch(() => ({}));
    if (err?.status === "model_locked" || err?.status === "model_unavailable") {
      log?.debug?.("AUTH", `Freebuff ${err.status} (${err.currentModel || "?"} -> ${model || "default"}) — ending session & re-minting`);
      await deleteSession(authToken, proxyOptions);
      await new Promise((r) => setTimeout(r, 500));
      resp = await doMint();
    }
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Freebuff session failed: ${resp.status} ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Freebuff session returned non-JSON"); }
  return data;
}

async function ensureSession(authToken, model, proxyOptions, log) {
  const want = model || DEFAULT_MODEL;
  const cached = sessionCache.get(authToken);
  if (cached && Date.now() < cached.expiresAt) {
    if (cached.model === want) return cached;
    // One live session on another model — end it and switch.
    log?.debug?.("AUTH", `Freebuff switching session model ${cached.model} -> ${want}`);
    await deleteSession(authToken, proxyOptions);
    sessionCache.delete(authToken);
  }
  const data = await mintSession(authToken, want, proxyOptions, log);
  const entry = {
    instanceId: data.instanceId,
    model: data.model || want,
    expiresAt: Date.now() + Math.max(1, (data.remainingMs || 3_600_000) / 1000 - 60) * 1000,
  };
  sessionCache.set(authToken, entry);
  log?.debug?.("AUTH", `Freebuff session minted: ${entry.instanceId} (model ${entry.model})`);
  return entry;
}

async function startRun(authToken, agentId, proxyOptions, log) {
  const resp = await proxyAwareFetch(RUNS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CLI_UA,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
  }, proxyOptions);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Freebuff agent-run START failed: ${resp.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  log?.debug?.("FETCH", `Freebuff run started: ${data.runId}`);
  return data.runId;
}

function finishRun(authToken, runId, proxyOptions) {
  // Fire-and-forget; FINISH failures are harmless.
  return proxyAwareFetch(RUNS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": CLI_UA,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ action: "FINISH", runId, status: "completed", totalSteps: 1, directCredits: 0, totalCredits: 0 }),
  }, proxyOptions).catch(() => {});
}
export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS["freebuff"]);
  }

  buildUrl() {
    return CHAT_URL;
  }

  buildHeaders(credentials, stream = true) {
    return {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": CLI_UA,
      Authorization: `Bearer ${credentials.accessToken || credentials.apiKey || ""}`,
    };
  }

  // CLI envelope: force stream + guarantee the Buffy marker system message.
  transformRequest(model, body, stream) {
    const transformed = super.transformRequest(model, body, stream);
    transformed.stream = true;
    const messages = Array.isArray(transformed.messages) ? [...transformed.messages] : [];
    const first = messages[0];
    const hasMarker =
      first?.role === "system" &&
      typeof first.content === "string" &&
      first.content.includes(FREEBUFF_SYSTEM_MARKER);
    if (!hasMarker) messages.unshift({ role: "system", content: FREEBUFF_SYSTEM_MARKER });
    transformed.messages = messages;
    return transformed;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const authToken = credentials.accessToken || credentials.apiKey || "";
    if (!authToken) throw new Error("Freebuff: no authToken on connection");
    const transformedBody = this.transformRequest(model, body, stream);
    const headers = this.buildHeaders(credentials, stream);

    const requestedModel = model || DEFAULT_MODEL;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let session;
      try {
        session = await ensureSession(authToken, requestedModel, proxyOptions, log);
      } catch (error) {
        log?.error?.("AUTH", `Freebuff session error: ${error.message}`);
        throw error;
      }
      // Upstream owns model assignment: one live session per account, model
      // fixed per session (limited tier -> mimo; availability fallbacks too).
      const sessionModel = session.model || requestedModel;
      transformedBody.model = sessionModel;

      let runId = "";
      try {
        runId = await startRun(authToken, MODEL_AGENT[sessionModel] || DEFAULT_AGENT, proxyOptions, log);
      } catch (error) {
        log?.error?.("FETCH", `Freebuff START error (${sessionModel}): ${error.message}`);
        throw error;
      }

      // The "CLI envelope" — upstream rejects the request without all of these:
      const envelope = {
        ...transformedBody,
        max_tokens: transformedBody.max_tokens || 4096,
        codebuff_metadata: {
          run_id: runId, // must be inside codebuff_metadata (top-level runId -> 400)
          client_id: randomId(13), // fresh per call (fixed values get fingerprinted)
          cost_mode: "free", // omit -> 402 out of credits
          freebuff_instance_id: session.instanceId,
        },
        provider: { data_collection: "deny" },
        stop: ["cb_easp"],
      };

      const response = await proxyAwareFetch(this.buildUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal,
      }, proxyOptions);

      if (response.status === 409) {
        // Session raced/switched underneath us — drop and re-mint.
        const errText = (await response.text()).slice(0, 300);
        finishRun(authToken, runId, proxyOptions);
        log?.debug?.("RETRY", `Freebuff 409: ${errText} — re-minting session`);
        resetSession(authToken);
        if (attempt < 3) continue;
      }
      if (response.status === 428 || response.status === 429) {
        const errText = (await response.text()).slice(0, 300);
        finishRun(authToken, runId, proxyOptions);
        log?.debug?.("RETRY", `Freebuff upstream ${response.status}: ${errText} — re-minting session`);
        resetSession(authToken);
        await new Promise((r) => setTimeout(r, response.status === 429 ? 2000 : 0));
        if (attempt < 3) continue;
      }

      finishRun(authToken, runId, proxyOptions);

      if (sessionModel !== requestedModel) {
        log?.debug?.("MODEL", `Freebuff session serves ${sessionModel} (requested ${requestedModel})`);
      }
      return { response, url: this.buildUrl(), headers, transformedBody };
    }
  }
}

export const __test__ = {
  ensureSession, mintSession, deleteSession, startRun, finishRun, resetSession,
  FREEBUFF_SYSTEM_MARKER, MODEL_AGENT, DEFAULT_MODEL, CLI_UA,
};

export default FreebuffExecutor;
