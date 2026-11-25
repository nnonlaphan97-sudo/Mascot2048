
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

export async function onRequest({ request, env }) {
  try {
    const db = env.DB;

    // GET LEADERBOARD
    if (request.method === "GET") {
      const { results } = await db.prepare(
        `SELECT s.*, p.playerName,
         p.playerTitle, p.avatarMascot
         FROM scores s
         JOIN players p ON p.id = s.playerId
         ORDER BY score DESC, date ASC`
      ).all();

      return reply({ records: results });
    }

    if (request.method !== "POST") {
      return reply({ error: "method" }, 405);
    }

    const b = await request.json();

    // VALIDATE PLAYER
    if (
      typeof b.id !== "string" ||
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

    // CREATE OR UPDATE PROFILE
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
            "INSERT INTO players VALUES (?,?,?,?,?,?)"
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
          return reply({ error: "duplicate" }, 409);
        }

        throw e;
      }

      return reply({ ok: true });
    }

    if (!p) {
      return reply({ error: "auth" }, 403);
    }

    // SAVE HIGH SCORE
    if (
      b.action === "score" &&
      Array.isArray(b.records)
    ) {
      const statements = b.records
        .slice(0, ids.length)
        .filter(r =>
          ids.includes(r.mascotId) &&
          Number.isSafeInteger(r.score) &&
          r.score > 0 &&
          r.score <= 100000000 &&
          r.score % 4 === 0
        )
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
            Date.now()
          )
        );

      if (statements.length) {
        await db.batch(statements);
      }

      return reply({ ok: true });
    }

    return reply({ error: "invalid" }, 400);

  } catch (e) {
    return reply({ error: "server" }, 503);
  }
}
