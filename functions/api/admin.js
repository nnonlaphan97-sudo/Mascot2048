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

// ========================================
// ADMIN API
// ========================================

export async function onRequest({ request, env }) {

  if (request.method !== "POST") {

    return reply({
      error: "method"
    }, 405);

  }

  let stage = "request";

  try {

    const b = await request.json();

    // ========================================
    // ADMIN PASSWORD
    // ========================================

    if (
      !env.ADMIN_PASSWORD ||
      typeof b?.password !== "string" ||
      b.password !== env.ADMIN_PASSWORD
    ) {

      return reply({
        error: "auth"
      }, 401);

    }

    stage = "database";

    const db = env.DB;

    if (!db) {

      throw new Error(
        "Missing DB binding"
      );

    }

    const now = Date.now();

    const {
      week: weekKey,
      month: monthKey
    } = getPeriods(now);

    const warnings = [];

    // ========================================
    // DATABASE HELPERS
    // ========================================

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
    // TOTAL STATISTICS
    // ========================================

    const activityStats = await first(
      "activityStats",
      `
      SELECT

        COUNT(*) AS visitors,

        COALESCE(
          SUM(visit_count), 0
        ) AS visits,

        COALESCE(
          SUM(games_played), 0
        ) AS games,

        COALESCE(
          SUM(
            CASE
              WHEN last_seen >= ?
              THEN 1
              ELSE 0
            END
          ), 0
        ) AS online

      FROM player_activity
      `,
      now - 360000
    );

    // ========================================
    // REGISTERED PLAYERS
    // ========================================

    const players = await first(
      "players",
      `
      SELECT COUNT(*) AS total
      FROM players
      `
    );

    // ========================================
    // PLAYER LIST
    // ========================================

    const playerList = await all(
      "playerList",
      `
      WITH score_stats AS (

        SELECT
          playerId,
          MAX(score) AS bestScore

        FROM scores

        GROUP BY playerId

      ),

      activity_stats AS (

        SELECT

          player_id,

          MAX(last_seen) AS lastSeen,

          COALESCE(
            SUM(games_played), 0
          ) AS gamesPlayed

        FROM player_activity

        WHERE player_id IS NOT NULL

        GROUP BY player_id

      )

      SELECT

        p.id,
        p.playerName,
        p.playerTitle,
        p.avatarMascot,

        COALESCE(
          s.bestScore, 0
        ) AS bestScore,

        a.lastSeen,

        COALESCE(
          a.gamesPlayed, 0
        ) AS gamesPlayed

      FROM players p

      LEFT JOIN score_stats s
        ON s.playerId = p.id

      LEFT JOIN activity_stats a
        ON a.player_id = p.id

      ORDER BY

        lastSeen DESC,
        bestScore DESC

      `
    );

    // ========================================
    // RECENT ACTIVITY
    // ========================================

    let recent = [];

    try {

      recent = await all(
        "recent",
        `
        WITH latest_activity AS (

          SELECT

            visitor_id,
            player_id,
            mascot_id,
            first_seen,
            last_seen,
            visit_count,
            games_played

          FROM player_activity

          ORDER BY last_seen DESC

          LIMIT 20

        )

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

        FROM latest_activity a

        LEFT JOIN players p
          ON p.id = a.player_id

        ORDER BY a.last_seen DESC
        `
      );

    } catch (error) {

      console.error(
        "Recent activity error:",
        error
      );

      // หาก JOIN ไม่สำเร็จ
      // ให้ลองอ่านข้อมูลกิจกรรมโดยตรง

      try {

        recent = await all(
          "recentFallback",
          `
          SELECT

            visitor_id,
            player_id,
            mascot_id,
            first_seen,
            last_seen,
            visit_count,
            games_played

          FROM player_activity

          ORDER BY last_seen DESC

          LIMIT 20
          `
        );

        const playerMap = new Map(
          playerList.map(
            p => [p.id, p]
          )
        );

        recent = recent.map(a => {

          const p = playerMap.get(
            a.player_id
          );

          return {

            ...a,

            playerName:
              p?.playerName || "",

            playerTitle:
              p?.playerTitle || "",

            avatarMascot:
              p?.avatarMascot || ""

          };

        });

      } catch (fallbackError) {

        console.error(
          "Recent fallback error:",
          fallbackError
        );

        warnings.push({
          section: "recent",
          error: "recent_unavailable"
        });

        recent = [];

      }

    }

    // ========================================
    // MASCOT POPULARITY
    // ========================================

    const popularity = await all(
      "popularity",
      `
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
      `
    );

    // ========================================
    // RANKING FIELDS
    // ========================================

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
    // WEEKLY / MONTHLY RANKING
    // ========================================

    async function getRanking(type, key) {

      return await all(

        type + "Ranking",

        `
        SELECT ${fields}

        FROM period_scores s

        JOIN players p
          ON p.id = s.playerId

        WHERE

          s.period_type = ?
          AND s.period_key = ?

        ORDER BY ${order}
        `,

        type,
        key

      );

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

          WHERE

            s.period_type = ?
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

        visitors:
          activityStats?.visitors || 0,

        visits:
          activityStats?.visits || 0,

        players:
          players?.total || 0,

        online:
          activityStats?.online || 0,

        games:
          activityStats?.games || 0

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

      warnings,

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

      stage === "request"
        ? 400
        : 503

    );

  }

}
