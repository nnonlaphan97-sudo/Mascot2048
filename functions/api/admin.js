
const reply = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });

// ========================================
// THAILAND TIME
// ========================================

function getPeriods(now) {

  const thai = new Date(
    now + 7 * 60 * 60 * 1000
  );

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

// ========================================
// ADMIN API
// ========================================

export async function onRequest({ request, env }) {

  if (request.method !== "POST") {
    return reply({ error: "method" }, 405);
  }

  try {

    const b = await request.json();

    // ========================================
    // ADMIN PASSWORD
    // ========================================

    if (
      !env.ADMIN_PASSWORD ||
      typeof b.password !== "string" ||
      b.password !== env.ADMIN_PASSWORD
    ) {
      return reply({ error: "auth" }, 401);
    }

    const db = env.DB;
    const now = Date.now();

    const periods = getPeriods(now);

    const weekKey = periods.week;
    const monthKey = periods.month;

    // ========================================
    // TOTAL VISITORS
    // ========================================

    const visitors = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM player_activity
    `).first();

    // ========================================
    // TOTAL VISITS
    // ========================================

    const visits = await db.prepare(`
      SELECT
        COALESCE(SUM(visit_count), 0) AS total
      FROM player_activity
    `).first();

    // ========================================
    // REGISTERED PLAYERS
    // ========================================

    const players = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM players
    `).first();

    // ========================================
    // ONLINE PLAYERS
    // ========================================

    const online = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM player_activity
      WHERE last_seen >= ?
    `).bind(
      now - 120000
    ).first();

    // ========================================
    // TOTAL GAMES
    // ========================================

    const games = await db.prepare(`
      SELECT
        COALESCE(SUM(games_played), 0) AS total
      FROM player_activity
    `).first();

    // ========================================
    // REGISTERED PLAYER LIST
    // ========================================

    const { results: playerList } =
      await db.prepare(`

        SELECT
          p.id,
          p.playerName,
          p.playerTitle,
          p.avatarMascot,

          COALESCE(MAX(s.score), 0)
            AS bestScore,

          (
            SELECT MAX(a.last_seen)
            FROM player_activity a
            WHERE a.player_id = p.id
          ) AS lastSeen,

          (
            SELECT COALESCE(
              SUM(a.games_played), 0
            )
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

      `).all();

    // ========================================
    // RECENT ACTIVITY
    // ========================================

    const { results: recent } =
      await db.prepare(`

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

      `).all();

    // ========================================
    // MASCOT POPULARITY
    // ========================================

    const { results: popularity } =
      await db.prepare(`

        SELECT
          mascotId,

          COUNT(DISTINCT playerId)
            AS totalPlayers,

          MAX(score)
            AS bestScore

        FROM scores

        GROUP BY mascotId

        ORDER BY
          totalPlayers DESC,
          bestScore DESC

      `).all();

    // ========================================
    // ALL TIME RANKING
    // ========================================

    const { results: allTimeRanking } =
      await db.prepare(`

        SELECT
          s.playerId,
          s.mascotId,
          s.score,
          s.date,
          p.playerName,
          p.playerTitle,
          p.avatarMascot

        FROM scores s

        JOIN players p
          ON p.id = s.playerId

        ORDER BY
          s.score DESC,
          s.date ASC,
          s.playerId ASC,
          s.mascotId ASC

      `).all();

    // ========================================
    // WEEKLY / MONTHLY RANKING
    // ========================================

    async function getRanking(type, key) {

      const { results } =
        await db.prepare(`

          SELECT
            s.playerId,
            s.mascotId,
            s.score,
            s.date,
            p.playerName,
            p.playerTitle,
            p.avatarMascot

          FROM period_scores s

          JOIN players p
            ON p.id = s.playerId

          WHERE
            s.period_type = ?
            AND s.period_key = ?

          ORDER BY
            s.score DESC,
            s.date ASC,
            s.playerId ASC,
            s.mascotId ASC

        `).bind(
          type,
          key
        ).all();

      return results;

    }

    const weeklyRanking =
      await getRanking(
        "week",
        weekKey
      );

    const monthlyRanking =
      await getRanking(
        "month",
        monthKey
      );

    // ========================================
    // CHAMPION HISTORY
    // ========================================

    async function getHistory(type, currentKey) {

      const { results } =
        await db.prepare(`

          WITH ranked AS (

            SELECT

              s.period_key AS periodKey,

              s.playerId,
              s.mascotId,
              s.score,
              s.date,

              p.playerName,
              p.playerTitle,
              p.avatarMascot,

              ROW_NUMBER() OVER (

                PARTITION BY s.period_key

                ORDER BY
                  s.score DESC,
                  s.date ASC,
                  s.playerId ASC,
                  s.mascotId ASC

              ) AS rank

            FROM period_scores s

            JOIN players p
              ON p.id = s.playerId

            WHERE
              s.period_type = ?
              AND s.period_key < ?

          )

          SELECT *

          FROM ranked

          WHERE rank = 1

          ORDER BY periodKey DESC

          LIMIT 52

        `).bind(
          type,
          currentKey
        ).all();

      return results;

    }

    const weeklyHistory =
      await getHistory(
        "week",
        weekKey
      );

    const monthlyHistory =
      await getHistory(
        "month",
        monthKey
      );

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

    console.error("Admin API error:", e);

    return reply({
      error: "server"
    }, 503);

  }

}
