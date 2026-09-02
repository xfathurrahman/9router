// ── FREEBUFF-PATCH (safe to revert wholesale) ──────────────────────────────
// Freebuff/Codebuff free tier (codebuff.com / freebuff.com).
// The upstream is NOT plain OpenAI: every chat needs a free session + an agent
// run + a "CLI envelope" (codebuff_metadata). See executors/freebuff.js.
// Auth: device-code OAuth (POST /api/auth/cli/code, poll GET /api/auth/cli/status)
// or a pasted cb_... CLI token.
export default {
  id: "freebuff",
  // Short model prefix (fb/mimo/mimo-v2.5). "fb" = Freebuff.
  alias: "fb",
  uiAlias: "fb",
  hidden: false,
  priority: 90,
  display: {
    name: "Freebuff",
    icon: "smart_toy",
    color: "#FF6E0B",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://www.codebuff.com/login",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Real chat endpoint is built by the executor (session/run dance per
    // request); this baseUrl is only used by generic validation/probes.
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    forceStream: true,
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "Freebuff-CLI/0.0.150",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  // Model ids + context windows from the freebuff CLI 0.0.166 binary.
  // SAFE LIST ONLY — models withdrawn upstream (minimax-m3, deepseek-v4-pro,
  // ox-alpha) or locked (glm-5.2 = referral) were REMOVED: requesting them is
  // itself an anomaly signal and contributed to account bans (2026-09-02).
  //   unmetered: mimo-v2.5, glm-5.3-flash, deepseek-v4-flash
  //   premium (shared 5 sessions/day): gpt-5.6-luna, solar-pro4
  //   claude-fable-5: premium, capacity not opened yet -> falls back
  models: [
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5", contextWindow: 1048576, maxOutput: 65536 },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1000000, maxOutput: 65536 },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1048576, maxOutput: 65536 },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1000000, maxOutput: 65536 },
    { id: "upstage/solar-pro4", name: "Solar Pro 4", contextWindow: 500000, maxOutput: 65536 },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5", contextWindow: 1000000, maxOutput: 65536 },
  ],
  oauth: {
    baseUrl: "https://www.codebuff.com",
    // Device-code flow reverse-engineered from the Freebuff CLI (login.py):
    // 1. POST /api/auth/cli/code {fingerprintId} -> loginUrl/fingerprintHash/expiresAt
    // 2. User opens loginUrl in a browser, signs in with GitHub/Google
    // 3. GET  /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt -> {default:{authToken,...}}
    stateUrl: "https://www.codebuff.com/api/auth/cli/code",
    tokenUrl: "https://www.codebuff.com/api/auth/cli/status",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
    pollInterval: 5000,
  },
  features: {
    usage: true,
  },
};
