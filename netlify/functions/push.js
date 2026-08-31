// netlify/functions/push.js
// 구독 등록/해지/테스트 발송을 한 곳에서 처리한다.
//
//   GET  /api/push            → 설정 상태와 공개키 (화면이 구독할 때 필요)
//   POST /api/push {action:"subscribe",   subscription, label}
//   POST /api/push {action:"unsubscribe", endpoint}
//   POST /api/push {action:"test",        endpoint}   → 본인에게만 시험 발송

const { configured, addSub, removeSub, readSubs, sendMany } = require("./_push");

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "no-store",
};

function reply(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: JSON_HEADERS, body: "" };

  // 화면이 구독을 시작하려면 공개키가 필요하다
  if (event.httpMethod === "GET") {
    return reply(200, {
      ok: true,
      configured: configured(),
      public_key: process.env.VAPID_PUBLIC_KEY || null,
    });
  }

  if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "허용되지 않은 방식" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return reply(400, { ok: false, error: "잘못된 요청 형식" });
  }

  try {
    if (body.action === "subscribe") {
      const r = await addSub(body.subscription, body.label, event, body.vid);
      return reply(200, { ok: true, ...r });
    }

    // 구독 명단 비우기.
    //
    // 앱을 여러 번 지웠다 깔면 쓰지 않는 구독이 쌓여 같은 알림이 여러 번 간다.
    // 식별자가 달라 서버가 같은 기기임을 알 수 없으므로, 한 번 비우고
    // 각자 다시 켜는 편이 확실하다. 점검용 토큰이 있어야 부를 수 있다.
    if (body.action === "reset") {
      const need = process.env.WATCH_TOKEN;
      if (need && body.token !== need) {
        return reply(401, { ok: false, error: "인증 실패" });
      }
      const { writeSubs, readSubs } = require("./_push");
      const before = (await readSubs(event)).length;
      await writeSubs([], event);
      return reply(200, { ok: true, cleared: before });
    }

    if (body.action === "unsubscribe") {
      const r = await removeSub(body.endpoint, event);
      return reply(200, { ok: true, ...r });
    }

    // 알림 확인.
    //
    // 세 경로가 모두 여기로 온다.
    //   - 알림의 확인 버튼
    //   - 알림 본문을 눌러 앱이 열림
    //   - 알림을 지움(밀어서 없앰)
    //   - 알림을 받은 뒤 앱을 그냥 연 경우 (action: "ack_open")
    //
    // 건별 확인자 수는 하루 단위 기록에 쌓는다. 같은 기기가 같은 건을
    // 여러 번 눌러도 한 번만 센다.
    if (body.action === "ack" || body.action === "ack_open") {
      const { readSubs, writeSubs, getLastEvent } = require("./_push");
      const logbook = require("./_logbook");

      const list = await readSubs(event);
      const s = list.find((x) => x.endpoint === body.endpoint);
      if (!s) return reply(404, { ok: false, error: "등록되지 않은 구독" });

      // 어느 알림에 대한 확인인지 가린다.
      //
      //   알림을 눌렀거나 지웠으면 그 알림의 번호가 함께 온다 → 그 건만 센다.
      //   알림 없이 앱만 열었으면 번호가 없다 → 가장 최근에 보낸 알림 한 건만
      //   확인으로 친다. 단, 오늘 보낸 것이어야 한다.
      //
      // 시간으로 끊으면(예: 12시간) 자정을 넘겨 어제 알림이 오늘 기록에
      // 섞인다. 오늘 기록에는 그 번호가 없으므로 발송 수 0짜리 빈 칸이
      // 생긴다. 날짜로 끊으면 그런 일이 없다.
      //
      // 그날 알림을 모두 확인 처리하는 방식도 검토했으나, 실제로 보지 않은
      // 알림까지 세어 수치가 후해지므로 쓰지 않는다.
      let targets = [];
      if (body.eid) {
        targets = [body.eid];
      } else {
        const last = await getLastEvent(event);
        const sameDay =
          last && last.at && logbook.kstDate(new Date(last.at)) === logbook.kstDate();
        if (sameDay && last.eid) targets = [last.eid];
      }

      // 반복 알림을 멈추는 용도. 단계는 숫자가 작을수록 심각하다.
      const rank = Number.isFinite(Number(body.rank)) ? Number(body.rank) : 3;
      s.ackRank = rank;
      s.ackAt = new Date().toISOString();
      // 앱이 살아 있음을 알린다. 오래 조용한 구독을 정리하는 기준이 된다.
      s.seen_at = s.ackAt;
      s.ackCount = (s.ackCount || 0) + 1;

      // 이 기기가 이미 확인한 건은 다시 세지 않는다.
      // 목록이 무한정 길어지지 않도록 최근 50건만 들고 있는다.
      const done = new Set(Array.isArray(s.ackEids) ? s.ackEids : []);
      const counted = [];
      for (const t of targets) {
        if (!t || done.has(t)) continue;
        done.add(t);
        counted.push(t);
      }
      s.ackEids = Array.from(done).slice(-50);
      s.ackEid = counted.length ? counted[counted.length - 1] : s.ackEid;

      const okWrite = await writeSubs(list, event);
      for (const t of counted) {
        try {
          await logbook.recordAck(t, event);
        } catch (_) {}
      }

      return reply(200, {
        ok: true,
        acked: true,
        counted,
        ackRank: rank,
        saved: okWrite,
        ackCount: s.ackCount,
      });
    }

    if (body.action === "test") {
      if (!configured()) return reply(503, { ok: false, error: "VAPID 키 미설정" });
      const list = await readSubs(event);
      const me = list.filter((s) => s.endpoint === body.endpoint);
      if (!me.length) return reply(404, { ok: false, error: "등록되지 않은 구독" });

      const r = await sendMany(
        me,
        {
          title: "영덕군 강우상황 · 알림 시험",
          body: "알림이 정상적으로 도착했습니다.",
          tag: `yd-rain-test-${Date.now()}`,
          group: "yd-rain-test",
          url: "/",
        },
        event
      );
      return reply(200, { ok: true, ...r });
    }

    return reply(400, { ok: false, error: "알 수 없는 요청" });
  } catch (e) {
    return reply(500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
};
