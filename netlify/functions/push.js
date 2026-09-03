// netlify/functions/push.js
// 구독 등록/해지/테스트 발송을 한 곳에서 처리한다.
//
//   GET  /api/push            → 설정 상태와 공개키 (화면이 구독할 때 필요)
//   POST /api/push {action:"subscribe",   subscription, label}
//   POST /api/push {action:"unsubscribe", endpoint}
//   POST /api/push {action:"test",        endpoint}   → 본인에게만 시험 발송
//   POST /api/push {action:"clear_ack",   token}      → 잘못 남은 확인 표시 일괄 삭제

const { configured, addSub, removeSub, readSubs, sendMany } = require("./_push");

// 알림을 받고 들어온 것으로 인정하는 기간.
//
// 달력 하루(00~24시)로 끊지 않는다. 23시 50분 알림을 받고 자정을 넘겨
// 00시 10분에 앱을 열면 "어제 발송"이 되어 반복이 안 멎기 때문이다.
// 비가 자정을 넘겨 이어지는 상황이 이 시스템의 주된 대상이므로,
// 마지막 발송 시각으로부터 24시간을 센다.
const DAY_MS = 24 * 60 * 60 * 1000;

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

    // 확인 표시 일괄 삭제.
    //
    // 잘못 저장된 ackRank 때문에 알림이 나가지 않는 상태를 되돌린다.
    // 명단은 그대로 두고 확인 표시만 지우므로 각자 다시 켤 필요가 없다.
    // 점검용 토큰이 있어야 부를 수 있다.
    if (body.action === "clear_ack") {
      const need = process.env.WATCH_TOKEN;
      if (need && body.token !== need) {
        return reply(401, { ok: false, error: "인증 실패" });
      }
      const { writeSubs } = require("./_push");
      const list = await readSubs(event);
      let cleared = 0;
      for (const s of list) {
        if (s.ackRank != null) cleared += 1;
        delete s.ackRank;
        delete s.ack;
      }
      const saved = await writeSubs(list, event);
      return reply(200, {
        ok: true,
        cleared,
        total: list.length,
        saved,
        ack_ranks: list.map((s) => (s.ackRank == null ? "-" : s.ackRank)).join(","),
      });
    }

    if (body.action === "unsubscribe") {
      const r = await removeSub(body.endpoint, event);
      return reply(200, { ok: true, ...r });
    }

    // 알림 확인.
    //
    // 네 경로가 모두 여기로 온다.
    //   - 알림의 확인 버튼
    //   - 알림 본문을 눌러 앱이 열림
    //   - 알림을 지움(밀어서 없앰)
    //   - 알림을 받은 뒤 앱을 그냥 연 경우 (action: "ack_open")
    if (body.action === "ack" || body.action === "ack_open") {
      const { readSubs, writeSubs } = require("./_push");
      const logbook = require("./_logbook");

      const list = await readSubs(event);
      const s = list.find((x) => x.endpoint === body.endpoint);
      if (!s) return reply(404, { ok: false, error: "등록되지 않은 구독" });

      const now = Date.now();
      const raw = body.rank;
      const hasRank =
        raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw));

      // 이 기기가 최근에 알림을 실제로 받았는지 본다.
      //
      // dispatch()는 발송할 때마다 s.sent = { count, at, rank }를 남긴다.
      // 해제 알림은 s.sent를 비우므로 dispatchClear()가 s.clearAt을 따로 남긴다.
      // 둘 중 나중 것을 기준으로 삼는다.
      const sentAt = s.sent && s.sent.at ? Number(s.sent.at) : 0;
      const clearAt = s.clearAt ? Number(s.clearAt) : 0;
      const lastAt = Math.max(Number.isFinite(sentAt) ? sentAt : 0, Number.isFinite(clearAt) ? clearAt : 0);
      const gotAlert = lastAt > 0 && now - lastAt >= 0 && now - lastAt <= DAY_MS;

      // 알림을 보고 들어온 것인지, 그냥 앱을 연 것인지 가른다.
      //
      // 단계가 함께 왔거나(알림의 확인 버튼·본문 탭·앱 안의 확인),
      // 최근에 이 기기로 알림이 나갔으면 알림을 보고 들어온 것으로 본다.
      // 비 안 오는 날 그냥 앱을 열어본 기기는 여기에 걸리지 않는다.
      //
      // 예전에는 단계가 없으면 기본값 3을 넣었다. 그래서 앱을 한 번 열기만
      // 해도 "관심단계까지 확인함"이 되어, dispatch()의
      //   if (s.ackRank != null && now.rank >= s.ackRank) continue;
      // 조건에 걸려 관심단계 알림이 영영 나가지 않았다.
      const fromAlert = hasRank || !!body.eid || gotAlert;

      // 반복을 멈출 단계. 단계는 숫자가 작을수록 심각하다.
      let rank = null;
      if (hasRank) {
        rank = Number(raw);
      } else if (gotAlert && s.sent && Number.isFinite(Number(s.sent.rank))) {
        // 해제 알림에는 단계가 없다. 그때는 반복을 멈출 것도 없으므로 건드리지 않는다.
        rank = Number(s.sent.rank);
      }
      if (rank != null) s.ackRank = rank;

      // 건별 확인 집계.
      //
      // 마지막 알림을 확인하면 그날 보낸 이전 알림도 함께 확인 처리한다.
      // 반복 알림 15건을 하나하나 누를 수는 없기 때문이다.
      // 하루 단위 기록이므로 자정이 지나면 저절로 새로 시작한다.
      let targets = [];
      if (fromAlert) {
        try {
          targets = await logbook.listTodayEventIds(event);
        } catch (_) {
          targets = [];
        }
        // 발송 기록보다 확인이 먼저 도착하는 일이 있다
        if (body.eid && !targets.includes(body.eid)) targets.push(body.eid);
      }

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
        from_alert: fromAlert,
        counted,
        rank_given: hasRank,
        ackRank: s.ackRank == null ? null : s.ackRank,
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
