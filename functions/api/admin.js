
const reply = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });

function getPeriods(now) {
  const thai = new Date(now + 7 * 3600000);
  const monday = new Date(thai);

  monday.setUTCDate(
    thai.getUTCDate() -
    ((thai.getUTCDay() + 6) % 7)
  );

  return {
    week: monday.toISOString().slice(0, 10),
    month: thai.toISOString().slice(0, 7)
  };
}

export async function onRequest({ request, env }) {

  if (request.method !== "POST") {
    return reply({ error: "method" }, 405);
  }

  let stage = "request";

  try {

    const b = await request.json();

    if (
      !env.ADMIN_PASSWORD ||
      typeof b.password !== "string" ||
      b.password !== env.ADMIN_PASSWORD
    ) {
      return reply({ error: "auth" }, 401);
    }

    const db = env.DB;
    const now = Date.now();

    stage = "database";

    const {
      week: weekKey,
      month: monthKey
    } = getPeriods(now);

    async function first(label, sql, ...args) {

      stage = label;

      let stmt = db.prepare(sql);

      if (args.length) {
        stmt = stmt.bind(...args);
      }

      return await stmt.first();
    }

    async function all(label, sql, ...args) {

      stage = label;

      let stmt = db.prepare(sql);

      if (args.length) {
        stmt = stmt.bind(...args);
      }

      const result = await stmt.all();

      return result.results || [];
    }

    // ========================================
    // VISITORS
    // ========================================

    const visitors = await first(
      "visitors",
      `SELECT COUNT(*) AS total
       FROM player_activity`
    );

    const visits = await first(
      "visits",
      `SELECT COALESCE(SUM(visit_count), 0) AS total
       FROM player_activity`
    );

    const players = await first(
      "players",
      `SELECT COUNT(*) AS total
       FROM players`
    );

    // ========================================
    // ONLINE - 6 MINUTES
    // ========================================

    const online = await first(
      "online",
      `SELECT COUNT(*) AS total
       FROM player_activity
       WHERE last_seen >= ?`,
      now - 360000
    );

    const games = await first(
      "games",
      `SELECT COALESCE(SUM(games_played), 0) AS total
       FROM player_activity`
    );

    // ========================================
    // PLAYER LIST
    // ========================================

    const playerList = await all(
      "playerList",
      `
      SELECT
        p.id,
        p.playerName,
        p.playerTitle,
        p.avatarMascot,

        COALESCE(MAX(s.score), 0) AS bestScore,

        (
          SELECT MAX(a.last_seen)
          FROM player_activity a
          WHERE a.player_id = p.id
        ) AS lastSeen,

        (
          SELECT COALESCE(SUM(a.games_played), 0)
          FROM player_activity a
          WHERE a.player_id = p.id
        ) AS gamesPlayed

      FROM players p

      LEFT JOIN scores s
        ON s.playerId = p.id

      GROUP BY p.id

      ORDER BY
        lastSeen DESC,
        bestScore DESC
      `
    );

    // ========================================
    // RECENT ACTIVITY
    // ========================================

    const recent = await all(
      "recent",
      `
      SELECT
        a.visitor_id,
        a.player_id,
        a.mascot_id,
        a.first_seen,
        a.last_seen,
        a.visit_count,
        a.games_played,
        p.playerName,
        p.playerTitle,
        p.avatarMascot

      FROM player_activity a

      LEFT JOIN players p
        ON p.id = a.player_id

      ORDER BY a.last_seen DESC

      LIMIT 100
      `
    );

    // ========================================
    // MASCOT POPULARITY
    // ========================================

    const popularity = await all(
      "popularity",
      `
      SELECT
        mascotId,
        COUNT(DISTINCT playerId) AS totalPlayers,
        MAX(score) AS bestScore

      FROM scores

      GROUP BY mascotId

      ORDER BY
        totalPlayers DESC,
        bestScore DESC
      `
    );

    const fields = `
      s.playerId,
      s.mascotId,
      s.score,
      s.date,
      p.playerName,
      p.playerTitle,
      p.avatarMascot
    `;

    const order = `
      s.score DESC,
      s.date ASC,
      s.playerId ASC,
      s.mascotId ASC
    `;

    // ========================================
    // ALL TIME RANKING
    // ========================================

    const allTimeRanking = await all(
      "allTimeRanking",
      `
      SELECT ${fields}

      FROM scores s

      JOIN players p
        ON p.id = s.playerId

      ORDER BY ${order}
      `
    );

    // ========================================
    // WEEKLY / MONTHLY
    // ========================================

    async function getRanking(type, key) {

      return await all(
        type + "Ranking",
        `
        SELECT ${fields}

        FROM period_scores s

        JOIN players p
          ON p.id = s.playerId

        WHERE s.period_type = ?
          AND s.period_key = ?

        ORDER BY ${order}
        `,
        type,
        key
      );
    }

    const weeklyRanking =
      await getRanking("week", weekKey);

    const monthlyRanking =
      await getRanking("month", monthKey);

    // ========================================
    // CHAMPION HISTORY
    // ========================================

    async function getHistory(type, key) {

      return await all(
        type + "History",
        `
        WITH ranked AS (

          SELECT
            s.period_key AS periodKey,

            ${fields},

            ROW_NUMBER() OVER (
              PARTITION BY s.period_key
              ORDER BY ${order}
            ) AS rank

          FROM period_scores s

          JOIN players p
            ON p.id = s.playerId

          WHERE s.period_type = ?
            AND s.period_key < ?

        )

        SELECT *

        FROM ranked

        WHERE rank = 1

        ORDER BY periodKey DESC

        LIMIT 52
        `,
        type,
        key
      );
    }

    const weeklyHistory =
      await getHistory("week", weekKey);

    const monthlyHistory =
      await getHistory("month", monthKey);

    // ========================================
    // RESPONSE
    // ========================================

    return reply({

      ok: true,

      stats: {
        visitors: visitors?.total || 0,
        visits: visits?.total || 0,
        players: players?.total || 0,
        online: online?.total || 0,
        games: games?.total || 0
      },

      playerList,
      recent,
      popularity,

      weekKey,
      monthKey,

      allTimeRanking,
      weeklyRanking,
      monthlyRanking,

      allTimeChampion:
        allTimeRanking[0] || null,

      weeklyChampion:
        weeklyRanking[0] || null,

      monthlyChampion:
        monthlyRanking[0] || null,

      weeklyHistory,
      monthlyHistory,

      updatedAt: now

    });

  } catch (e) {

    console.error(
      "Admin API error:",
      stage,
      e
    );

    return reply(
      {
        error: stage === "request"
          ? "invalid_request"
          : "server:" + stage
      },
      stage === "request" ? 400 : 503
    );

  }

}
