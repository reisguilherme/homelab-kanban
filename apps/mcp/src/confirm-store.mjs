import crypto from "node:crypto";

/**
 * Recursively sorts object keys and drops undefined properties so parameter
 * hashing is deterministic regardless of property insertion order.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out;
  }
  return value;
}

export function hashParams(action, params) {
  const canonical = JSON.stringify({
    action,
    params: canonicalize(params),
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * In-memory, single-use confirmation token store with TTL and caller-scope binding.
 */
export function createConfirmStore({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function pruneExpired(currentTime) {
    for (const [token, entry] of entries.entries()) {
      if (entry.expiresAt <= currentTime) {
        entries.delete(token);
      }
    }
  }

  function propose({ scope, action, params, preview }) {
    const createdAt = now();
    pruneExpired(createdAt);

    const token = `confirm_${crypto.randomBytes(24).toString("hex")}`;
    const paramsHash = hashParams(action, params);
    const expiresAt = createdAt + ttlMs;

    entries.set(token, {
      token,
      profile: scope.profile,
      domainId: scope.domainId,
      allowedWorkspaceId: scope.allowedWorkspaceId,
      action,
      paramsHash,
      params,
      preview,
      createdAt,
      expiresAt,
    });

    return {
      confirm_token: token,
      action,
      params_hash: paramsHash,
      expires_at: new Date(expiresAt).toISOString(),
      ttl_seconds: Math.round(ttlMs / 1000),
      preview,
    };
  }

  function consume({ token, scope, expectedParamsHash, expectedAction }) {
    const currentTime = now();
    const entry = entries.get(token);
    if (!entry) {
      pruneExpired(currentTime);
      return {
        ok: false,
        error: "CONFIRM_TOKEN_INVALID",
        message: "Confirmation token is missing, unknown, or already consumed.",
      };
    }

    if (entry.expiresAt <= currentTime) {
      entries.delete(token);
      pruneExpired(currentTime);
      return {
        ok: false,
        error: "CONFIRM_TOKEN_EXPIRED",
        message: "Confirmation token has expired (5 minute TTL). Re-propose the mutation.",
      };
    }

    if (
      entry.profile !== scope.profile ||
      entry.domainId !== scope.domainId ||
      entry.allowedWorkspaceId !== scope.allowedWorkspaceId
    ) {
      return {
        ok: false,
        error: "CONFIRM_TOKEN_SCOPE_MISMATCH",
        message: "Confirmation token does not belong to the caller domain/profile.",
      };
    }

    if (expectedAction && entry.action !== expectedAction) {
      return {
        ok: false,
        error: "CONFIRM_TOKEN_ACTION_MISMATCH",
        message: `Expected action '${expectedAction}', got '${entry.action}'.`,
      };
    }

    if (expectedParamsHash && entry.paramsHash !== expectedParamsHash) {
      return {
        ok: false,
        error: "CONFIRM_TOKEN_HASH_MISMATCH",
        message: "Provided params_hash does not match the proposed mutation.",
      };
    }

    entries.delete(token);
    pruneExpired(currentTime);
    return { ok: true, entry };
  }

  return {
    propose,
    consume,
    size: () => entries.size,
  };
}
