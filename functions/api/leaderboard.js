
const ids = [
  "polcasan",
  "nongnooong",
  "mrsaturnworld",
  "permpoon",
  "yuzumumu",
  "jaidee",
  "tomafox",
  "avocean",
  "jummo",
  "babii",
  "lookkhunnoo",
  "samruay",
  "kingman",
  "muvmuv",
  "lykyou",
  "paody",
  "lunar",
  "domaii",
  "neona",
  "smyle",
  "wesley",
  "metaa",
  "any",
  "guinzly",
  "momo",
  "ceri",
  "nilknhake",
  "rexxa",
  "vimmy",
  "jewel",
  "ponpon",
  "flarey",
  "renjin"
];

const reply = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });

// ========================================
// PERIOD - THAILAND TIME
// ========================================

function getPeriods(now = Date.now()) {

  const thai = new Date(
    now + 7 * 60 * 60 * 1000
  );

  const year = thai.getUTCFullYear();

  const month = String(
    thai.getUTCMonth() + 1
  ).padStart(2, "0");

  const monday = new Date(thai);

  monday.setUTCDate(
    thai.getUTCDate() -
    ((thai.getUTCDay() + 6) % 7)
  );

  return {
    week: monday.toISOString().slice(0, 10),
    month: `${year}-${month}`
  };
}

function validScore(r) {
  return (
    r &&
    ids.includes(r.mascotId) &&
    Number.isSafeInteger(r.score) &&
    r.score > 0 &&
    r.score <= 100000000 &&
    r.score % 4 === 0
  );
}

// ========================================
// MAIN API
// ========================================

export async function onRequest({ request, env }) {

  try {

    const db = env.DB;
    const now = Date.now();
    const periods = getPeriods(now);

    // ========================================
    // GET LEADERBOARD
    // ========================================

    if (request.method === "GET") {

      const url = new URL(request.url);

      const period =
        url.searchParams.get("period") || "all";

      if (!["all", "week", "month"].includes(period)) {
        return reply({ error: "invalid" }, 400);
      }

      // ALL TIME

      if (period === "all") {

        const { results } = await db.prepare(
          `SELECT s.*, p.playerName,
           p.playerTitle, p.avatarMascot
           FROM scores s
           JOIN players p ON p.id = s.playerId
           ORDER BY score DESC, date ASC`
        ).all();

        return reply({
          records: results,
          period: "all",
          periods
        });

      }

      // WEEKLY / MONTHLY

      const periodKey = periods[period];

      const { results } = await db.prepare(
        `SELECT
           s.playerId,
           s.mascotId,
           s.score,
           s.date,
           p.playerName,
           p.playerTitle,
           p.avatarMascot
         FROM period_scores s
         JOIN players p ON p.id = s.playerId
         WHERE s.period_type = ?
           AND s.period_key = ?
         ORDER BY s.score DESC, s.date ASC`
      ).bind(
        period,
        periodKey
      ).all();

      return reply({
        records: results,
        period,
        periodKey,
        periods
      });

    }

    if (request.method !== "POST") {
      return reply({ error: "method" }, 405);
    }

    const b = await request.json();

    // ========================================
    // VALIDATE PLAYER
    // ========================================

    if (
      typeof b.id !== "string" ||
      !b.id ||
      b.id.length > 100 ||
      typeof b.secret !== "string" ||
      !/^[a-f0-9]{64}$/.test(b.secret)
    ) {
      return reply({ error: "invalid" }, 400);
    }

    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(b.secret)
        )
      ),
      x => x.toString(16).padStart(2, "0")
    ).join("");

    const p = await db.prepare(
      "SELECT * FROM players WHERE id=?"
    ).bind(b.id).first();

    if (p && p.secret_hash !== hash) {
      return reply({ error: "auth" }, 403);
    }

    // ========================================
    // CREATE OR UPDATE PROFILE
    // ========================================

    if (b.action === "profile") {

      const name = String(b.name || "").trim();
      const title = String(b.title || "").trim();

      const key = (title + name)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s\p{Cf}]/gu, "");

      if (
        !name ||
        !title ||
        !key ||
        name.length > 60 ||
        title.length > 30 ||
        !ids.includes(b.avatar)
      ) {
        return reply({ error: "invalid" }, 400);
      }

      try {

        if (p) {

          await db.prepare(
            `UPDATE players
             SET name_key=?,
                 playerName=?,
                 playerTitle=?,
                 avatarMascot=?
             WHERE id=? AND secret_hash=?`
          ).bind(
            key,
            name,
            title,
            b.avatar,
            b.id,
            hash
          ).run();

        } else {

          await db.prepare(
            `INSERT INTO players
             VALUES (?,?,?,?,?,?)`
          ).bind(
            b.id,
            hash,
            key,
            name,
            title,
            b.avatar
          ).run();

        }

      } catch (e) {

        if (String(e).includes("UNIQUE")) {
          return reply(
            { error: "duplicate" },
            409
          );
        }

        throw e;

      }

      return reply({ ok: true });

    }

    if (!p) {
      return reply({ error: "auth" }, 403);
    }

    // ========================================
    // SAVE ALL-TIME HIGH SCORE
    // ORIGINAL SYSTEM
    // ========================================

    if (
      b.action === "score" &&
      Array.isArray(b.records)
    ) {

      const statements = b.records
        .slice(0, ids.length)
        .filter(validScore)
        .map(r =>
          db.prepare(
            `INSERT INTO scores VALUES (?,?,?,?)
             ON CONFLICT(playerId, mascotId)
             DO UPDATE SET
               score = excluded.score,
               date = excluded.date
             WHERE excluded.score > scores.score`
          ).bind(
            b.id,
            r.mascotId,
            r.score,
            now
          )
        );

      if (statements.length) {
        await db.batch(statements);
      }

      return reply({ ok: true });

    }

    // ========================================
    // SAVE CURRENT GAME SCORE
    // ALL TIME + WEEKLY + MONTHLY
    // ========================================

    if (b.action === "gameScore") {

      const r = {
        mascotId: b.mascotId,
        score: b.score
      };

      if (!validScore(r)) {
        return reply(
          { error: "invalid" },
          400
        );
      }

      const statements = [];

      // ALL TIME

      statements.push(

        db.prepare(
          `INSERT INTO scores
           VALUES (?,?,?,?)
           ON CONFLICT(playerId, mascotId)
           DO UPDATE SET
             score = excluded.score,
             date = excluded.date
           WHERE excluded.score > scores.score`
        ).bind(
          b.id,
          r.mascotId,
          r.score,
          now
        )

      );

      // WEEKLY AND MONTHLY

      for (const type of ["week", "month"]) {

        statements.push(

          db.prepare(
            `INSERT INTO period_scores (
               period_type,
               period_key,
               playerId,
               mascotId,
               score,
               date
             )
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(
               period_type,
               period_key,
               playerId,
               mascotId
             )
             DO UPDATE SET
               score = excluded.score,
               date = excluded.date
             WHERE excluded.score > period_scores.score`
          ).bind(
            type,
            periods[type],
            b.id,
            r.mascotId,
            r.score,
            now
          )

        );

      }

      await db.batch(statements);

      return reply({
        ok: true,
        periods
      });

    }

    return reply({ error: "invalid" }, 400);

  } catch (e) {

    return reply(
      { error: "server" },
      503
    );

  }

}
