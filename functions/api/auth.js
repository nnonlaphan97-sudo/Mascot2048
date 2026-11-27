
const encoder = new TextEncoder();

const ITERATIONS = 100000;
const WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const reply = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });

// ========================================
// SECURITY
// ========================================

function hex(bytes) {
  return Array.from(
    bytes,
    x => x.toString(16).padStart(2, "0")
  ).join("");
}

function randomHex(length = 32) {
  return hex(
    crypto.getRandomValues(
      new Uint8Array(length)
    )
  );
}

async function sha256(value) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(value)
      )
    )
  );
}

async function hashPassword(password, salt) {

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: ITERATIONS
    },
    key,
    256
  );

  return hex(new Uint8Array(bits));
}

function equal(a, b) {

  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

function normalizeUsername(value) {

  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_.]{4,30}$/.test(value);
}

function validPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128
  );
}

function validSecret(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{64}$/.test(value)
  );
}

// ========================================
// RATE LIMIT
// ========================================

async function allowAttempt(db, key) {

  const now = Date.now();

  const row = await db.prepare(`
    INSERT INTO auth_attempts (
      attempt_key,
      attempts,
      window_start
    )
    VALUES (?, 1, ?)

    ON CONFLICT(attempt_key)
    DO UPDATE SET

      attempts = CASE
        WHEN window_start <= ?
        THEN 1
        ELSE attempts + 1
      END,

      window_start = CASE
        WHEN window_start <= ?
        THEN excluded.window_start
        ELSE window_start
      END

    RETURNING attempts
  `).bind(
    key,
    now,
    now - WINDOW,
    now - WINDOW
  ).first();

  return row &&
    row.attempts <= MAX_ATTEMPTS;
}

// ========================================
// VERIFY EXISTING PLAYER
// ========================================

async function verifyPlayer(db, id, secret) {

  if (
    typeof id !== "string" ||
    !id ||
    id.length > 100 ||
    !validSecret(secret)
  ) {
    return null;
  }

  const player = await db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).bind(id).first();

  if (!player) {
    return null;
  }

  const hash = await sha256(secret);

  if (!equal(player.secret_hash, hash)) {
    return null;
  }

  return player;
}

// ========================================
// GET PLAYER DATA
// ========================================

async function playerData(db, id) {

  const player = await db.prepare(`
    SELECT
      id,
      playerName,
      playerTitle,
      avatarMascot
    FROM players
    WHERE id = ?
  `).bind(id).first();

  const { results } = await db.prepare(`
    SELECT mascotId, score, date
    FROM scores
    WHERE playerId = ?
    ORDER BY score DESC
  `).bind(id).all();

  return {
    player,
    scores: results
  };
}

// ========================================
// MAIN AUTH API
// ========================================

export async function onRequest({
  request,
  env
}) {

  try {

    if (request.method !== "POST") {
      return reply({
        error: "method"
      }, 405);
    }

    const origin = request.headers.get("Origin");

    if (
      origin &&
      origin !== new URL(request.url).origin
    ) {
      return reply({
        error: "origin"
      }, 403);
    }

    const raw = await request.text();

    if (raw.length > 8192) {
      return reply({
        error: "invalid"
      }, 400);
    }

    let b;

    try {
      b = JSON.parse(raw);
    } catch {
      return reply({
        error: "invalid"
      }, 400);
    }

    if (!b || typeof b !== "object") {
      return reply({
        error: "invalid"
      }, 400);
    }

    const db = env.DB;

    // ========================================
    // ACCOUNT STATUS
    // ========================================

    if (b.action === "status") {

      const player = await verifyPlayer(
        db,
        b.id,
        b.secret
      );

      if (!player) {
        return reply({
          error: "auth"
        }, 403);
      }

      const account = await db.prepare(`
        SELECT username
        FROM player_accounts
        WHERE player_id = ?
      `).bind(player.id).first();

      return reply({
        ok: true,
        registered: !!account,
        username: account?.username || null
      });
    }

    // ========================================
    // VALIDATE USERNAME AND PASSWORD
    // ========================================

    const username = normalizeUsername(
      b.username
    );

    if (!validUsername(username)) {
      return reply({
        error: "invalidUsername"
      }, 400);
    }

    if (
      !["register", "login", "recover"]
        .includes(b.action)
    ) {
      return reply({
        error: "invalid"
      }, 400);
    }

    if (!validPassword(b.password)) {
      return reply({
        error: "invalidPassword"
      }, 400);
    }

    // ========================================
    // LIMIT AUTH ATTEMPTS
    // ========================================

    const ip = request.headers.get(
      "CF-Connecting-IP"
    ) || "unknown";

    const ipKey = await sha256(
      "ip:" + ip
    );

    if (!await allowAttempt(db, ipKey)) {
      return reply({
        error: "rateLimit"
      }, 429);
    }

    const userKey = await sha256(
      "user:" + username
    );

    if (!await allowAttempt(db, userKey)) {
      return reply({
        error: "rateLimit"
      }, 429);
    }

    // ========================================
    // REGISTER
    // ========================================

    if (b.action === "register") {

      const player = await verifyPlayer(
        db,
        b.id,
        b.secret
      );

      if (!player) {
        return reply({
          error: "auth"
        }, 403);
      }

      const existing = await db.prepare(`
        SELECT username
        FROM player_accounts
        WHERE player_id = ?
      `).bind(player.id).first();

      if (existing) {
        return reply({
          error: "alreadyRegistered"
        }, 409);
      }

      const salt = randomHex(32);

      const passwordHash = await hashPassword(
        b.password,
        salt
      );

      try {

        const result = await db.prepare(`
          INSERT INTO player_accounts (
            player_id,
            username,
            password_hash,
            password_salt,
            recovery_hash,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?
          FROM players
          WHERE id = ?
            AND secret_hash = ?
        `).bind(
          player.id,
          username,
          passwordHash,
          salt,
          "",
          Date.now(),
          player.id,
          player.secret_hash
        ).run();

        if (!result.meta.changes) {
          return reply({
            error: "auth"
          }, 403);
        }

      } catch (e) {

        if (String(e).includes("UNIQUE")) {
          return reply({
            error: "duplicateAccount"
          }, 409);
        }

        throw e;
      }

      return reply({
        ok: true,
        username,
        id: player.id
      });
    }

    // ========================================
    // FIND ACCOUNT
    // ========================================

    const account = await db.prepare(`
      SELECT *
      FROM player_accounts
      WHERE username = ?
    `).bind(username).first();

    // ========================================
    // LOGIN
    // ========================================

    if (b.action === "login") {

      const passwordHash = await hashPassword(
        b.password,
        account?.password_salt ||
          "00000000000000000000000000000000"
      );

      if (
        !account ||
        !equal(
          passwordHash,
          account.password_hash
        )
      ) {
        return reply({
          error: "wrongCredentials"
        }, 401);
      }

      const data = await playerData(
        db,
        account.player_id
      );

      if (!data.player) {
        return reply({
          error: "auth"
        }, 403);
      }

      const secret = randomHex(32);
      const secretHash = await sha256(secret);

      const result = await db.prepare(`
        UPDATE players
        SET secret_hash = ?
        WHERE id = ?
          AND EXISTS (
            SELECT 1
            FROM player_accounts
            WHERE player_id = players.id
              AND password_hash = ?
              AND password_salt = ?
          )
      `).bind(
        secretHash,
        account.player_id,
        account.password_hash,
        account.password_salt
      ).run();

      if (!result.meta.changes) {
        return reply({
          error: "auth"
        }, 403);
      }

      return reply({
        ok: true,
        username,
        id: account.player_id,
        secret,
        ...data
      });
    }

    // ========================================
    // FORGOT PASSWORD
    // NO RECOVERY CODE
    // ========================================

    if (b.action === "recover") {

      const player = await verifyPlayer(
        db,
        b.id,
        b.secret
      );

      if (
        !account ||
        !player ||
        account.player_id !== player.id
      ) {
        return reply({
          error: "auth"
        }, 403);
      }

      const salt = randomHex(32);

      const passwordHash = await hashPassword(
        b.password,
        salt
      );

      const result = await db.prepare(`
        UPDATE player_accounts
        SET password_hash = ?,
            password_salt = ?,
            recovery_hash = ''
        WHERE player_id = ?
          AND username = ?
          AND EXISTS (
            SELECT 1
            FROM players
            WHERE id = player_accounts.player_id
              AND secret_hash = ?
          )
      `).bind(
        passwordHash,
        salt,
        player.id,
        username,
        player.secret_hash
      ).run();

      if (!result.meta.changes) {
        return reply({
          error: "auth"
        }, 403);
      }

      const data = await playerData(
        db,
        player.id
      );

      return reply({
        ok: true,
        username,
        id: player.id,
        secret: b.secret,
        ...data
      });
    }

    return reply({
      error: "invalid"
    }, 400);

  } catch (e) {

    console.error("AUTH ERROR:", e.message);

    return reply({
      error: "server"
    }, 503);

  }
}
