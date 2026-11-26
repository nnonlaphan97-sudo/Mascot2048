
export async function onRequest({ request, env }) {
  const reply = (data, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "no-store"
      }
    });

  if (request.method !== "POST") {
    return reply({ error: "method" }, 405);
  }

  try {
    const b = await request.json();

    const visitorId = b.visitorId;
    const playerId = b.playerId || null;
    const mascotId = b.mascotId || null;
    const event = b.event || "heartbeat";
    const now = Date.now();

    if (
      typeof visitorId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(visitorId) ||
      !["visit", "heartbeat", "play"].includes(event)
    ) {
      return reply({ error: "invalid" }, 400);
    }

    if (
      (playerId !== null &&
        (typeof playerId !== "string" ||
         playerId.length > 100)) ||
      (mascotId !== null &&
        (typeof mascotId !== "string" ||
         mascotId.length > 50))
    ) {
      return reply({ error: "invalid" }, 400);
    }

    let verifiedPlayer = null;

    if (
      playerId &&
      typeof b.secret === "string" &&
      /^[a-f0-9]{64}$/.test(b.secret)
    ) {
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(b.secret)
          )
        ),
        x => x.toString(16).padStart(2, "0")
      ).join("");

      const player = await env.DB.prepare(
        "SELECT id FROM players WHERE id=? AND secret_hash=?"
      ).bind(playerId, hash).first();

      verifiedPlayer = player ? player.id : null;
    }

    const visits = event === "visit" ? 1 : 0;
    const games = event === "play" ? 1 : 0;

    await env.DB.prepare(`
      INSERT INTO player_activity (
        visitor_id,
        player_id,
        mascot_id,
        first_seen,
        last_seen,
        visit_count,
        games_played
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)

      ON CONFLICT(visitor_id)
      DO UPDATE SET
        player_id = COALESCE(
          excluded.player_id,
          player_activity.player_id
        ),
        mascot_id = COALESCE(
          excluded.mascot_id,
          player_activity.mascot_id
        ),
        last_seen = excluded.last_seen,
        visit_count =
          player_activity.visit_count +
          excluded.visit_count,
        games_played =
          player_activity.games_played +
          excluded.games_played
    `).bind(
      visitorId,
      verifiedPlayer,
      mascotId,
      now,
      now,
      visits,
      games
    ).run();

    return reply({ ok: true });

  } catch (e) {
    return reply({ error: "server" }, 500);
  }
}

