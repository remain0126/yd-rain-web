// netlify/functions/ingest.js
// 소방서 PC(국내 IP)가 영덕군청에서 직접 긁어 보낸 HTML을 받아 처리·저장한다.
//
// [왜 필요한가]
// 영덕군청이 Netlify(해외 클라우드) IP의 자동 접속을 방화벽으로 차단했다.
// 사람 브라우저(국내 IP)는 허용되므로, 소방서 PC가 대신 페이지를 긁어
// 이 함수로 HTML을 보내면, 그 뒤 처리(이력·단계판정·기상특보)는 기존과 동일하다.
// refresh-background.js의 저장 로직(순서 역전 방지)을 그대로 따른다.
//
// [보안] 아무나 가짜 자료를 밀어넣지 못하도록 토큰을 확인한다.
//   Netlify 환경변수 INGEST_TOKEN 과 요청 헤더 x-ingest-token 이 같아야 한다.

const { buildDataFromHtml } = require("./_build");

function connectStore(name, event) {
  const blobs = require("@netlify/blobs");
  if (event && typeof blobs.connectLambda === "function") {
    blobs.connectLambda(event);
  }
  return blobs.getStore(name);
}

function headerValue(event, name) {
  const h = (event && event.headers) || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function (event) {
  const started = Date.now();

  // POST만 허용
  if (event && event.httpMethod && event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "POST만 허용됩니다" });
  }

  // 토큰 확인
  const expected = process.env.INGEST_TOKEN || "";
  const got =
    headerValue(event, "x-ingest-token") ||
    (event && event.queryStringParameters && event.queryStringParameters.token) ||
    "";
  if (!expected) {
    return jsonResponse(500, { ok: false, error: "서버에 INGEST_TOKEN이 설정되지 않았습니다" });
  }
  if (got !== expected) {
    return jsonResponse(401, { ok: false, error: "토큰이 올바르지 않습니다" });
  }

  // 본문(HTML) 확보
  let html = event && event.body ? event.body : "";
  if (event && event.isBase64Encoded && html) {
    try {
      html = Buffer.from(html, "base64").toString("utf-8");
    } catch (_) {}
  }
  if (!html || html.length < 200) {
    return jsonResponse(400, { ok: false, error: "HTML 본문이 비어 있거나 너무 짧습니다", bytes: html.length });
  }

  try {
    const store = connectStore("rainfall", event);

    // 순서 역전 방지의 기준 시각 = "PC가 영덕군청을 긁기 시작한 시각".
    // 조회가 1~2분씩 걸려 여러 건이 겹쳐 들어와도, 더 늦게 출발한(=더 새로운)
    // 자료가 항상 이긴다. PC가 x-fetched-at 헤더로 보내며, 없으면 서버 수신시각.
    const fetchedAtHeader = headerValue(event, "x-fetched-at");
    const fetchStartedAt =
      fetchedAtHeader && !Number.isNaN(Date.parse(fetchedAtHeader))
        ? new Date(fetchedAtHeader).toISOString()
        : new Date(started).toISOString();

    // 받은 HTML로 기존 파이프라인 그대로 처리 (이력 병합·단계 판정·기상특보)
    const data = await buildDataFromHtml(html, true, event);
    // 화면의 "자료기준" 시각도 PC가 실제로 긁은 시각으로 맞춘다(수신 지연 반영 X).
    data.fetched_at = fetchStartedAt;

    // 더 새로운 자료가 이미 저장됐는지 확인(순서 역전 방지) — refresh-background와 동일
    let stale = false;
    try {
      const cur = await store.get("latest", { type: "json" });
      if (cur && cur.fetch_started_at && cur.fetch_started_at > fetchStartedAt) {
        stale = true;
      }
    } catch (_) {}

    if (stale) {
      return jsonResponse(200, { ok: true, skipped: "더 새로운 자료가 이미 저장됨" });
    }

    data.fetch_started_at = fetchStartedAt;
    data.stored_at = new Date().toISOString();
    data.fetch_elapsed_ms = Date.now() - started;
    data.blobs_ok = true;
    data.source = "pc-ingest"; // 이 자료가 PC 중계로 들어왔음을 표시
    await store.setJSON("latest", data);

    try {
      await store.setJSON("refresh-lock", { at: null, done_at: data.stored_at, by: "ingest" });
    } catch (_) {}

    return jsonResponse(200, {
      ok: true,
      stored_at: data.stored_at,
      date_label: data.date_label || null,
      rows: data.rows ? Object.keys(data.rows).length : 0,
      elapsed_ms: Date.now() - started,
    });
  } catch (e) {
    return jsonResponse(500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
};
