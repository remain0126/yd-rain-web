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
      const r = await addSub(body.subscription, body.label, event);
      return reply(200, { ok: true, ...r });
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
      // 앱만 연 경우에는 최근에 보낸 알림을 대상으로 본다.
      let eid = body.eid || null;
      let last = null;
      if (!eid) {
        last = await getLastEvent(event);
        // 너무 오래된 알림까지 확인으로 치지 않는다
        const fresh =
          last && last.at && Date.now() - new Date(last.at).getTime() < 12 * 3600 * 1000;
        if (fresh) eid = last.eid;
      }

      // 반복 알림을 멈추는 용도. 단계는 숫자가 작을수록 심각하다.
      const rank = Number.isFinite(Number(body.rank)) ? Number(body.rank) : 3;
      s.ackRank = rank;
      s.ackAt = new Date().toISOString();
      s.ackCount = (s.ackCount || 0) + 1;

      // 같은 건을 이미 확인했으면 다시 세지 않는다
      let counted = false;
      if (eid && s.ackEid !== eid) {
        s.ackEid = eid;
        counted = true;
      }

      const okWrite = await writeSubs(list, event);
      if (counted) {
        try {
          await logbook.recordAck(eid, event);
        } catch (_) {}
      }

      return reply(200, {
        ok: true,
        acked: true,
        eid,
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
