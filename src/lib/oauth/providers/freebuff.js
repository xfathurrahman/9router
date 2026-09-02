// ── FREEBUFF-PATCH (safe to revert wholesale) ──────────────────────────────
// Freebuff/Codebuff device-code login, mirrors the official CLI (login.py):
// 1. POST /api/auth/cli/code {fingerprintId} → loginUrl, fingerprintHash, expiresAt
// 2. User opens loginUrl in a browser and signs in with GitHub/Google
// 3. GET  /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt
//        → { default: { authToken, id, email, name, ... } }  (401 while pending)
import { PROVIDER_OAUTH } from "open-sse/providers/index.js";

const FREEBUFF_CONFIG = { ...PROVIDER_OAUTH["freebuff"] };

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const fingerprintId = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(config.stateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
      body: JSON.stringify({ fingerprintId }),
    });
    if (!response.ok) throw new Error(`Freebuff code request failed: ${await response.text()}`);
    const data = await response.json();
    if (!data.loginUrl || !data.fingerprintHash) {
      throw new Error(`Freebuff state error: missing loginUrl/fingerprintHash`);
    }
    return {
      device_code: JSON.stringify({
        fingerprintId,
        fingerprintHash: data.fingerprintHash,
        expiresAt: data.expiresAt,
      }),
      verification_uri: data.loginUrl,
      user_code: "",
      interval: (config.pollInterval || 5000) / 1000,
      expires_in: Math.round((data.expiresInMs || 3600_000) / 1000),
      _isFreebuff: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    let params;
    try {
      params = JSON.parse(deviceCode);
    } catch {
      return { ok: false, data: { error: "invalid_device_code" } };
    }
    const url = `${config.tokenUrl}?${new URLSearchParams({
      fingerprintId: params.fingerprintId,
      fingerprintHash: params.fingerprintHash,
      expiresAt: params.expiresAt,
    })}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
    });
    // 401 = not logged in yet → keep polling
    if (response.status === 401) {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (!response.ok) {
      return { ok: false, data: { error: `request_failed_${response.status}` } };
    }
    const data = await response.json();
    const user = data.default || data.user || (data.status ? data : null);
    if (user?.authToken) {
      return {
        ok: true,
        data: {
          access_token: user.authToken,
          refresh_token: "",
          token_type: "Bearer",
          expires_in: 0, // CLI tokens are long-lived; no refresh endpoint known
          email: user.email || "",
          name: user.name || "",
          user_id: user.id || "",
        },
      };
    }
    return { ok: true, data: { error: "authorization_pending" } };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: "",
    expiresIn: null,
    email: tokens.email || null,
    displayName: tokens.name || null,
    providerSpecificData: {
      authMethod: "device_code",
      freebuffUserId: tokens.user_id || "",
    },
  }),
};

export default freebuff;
