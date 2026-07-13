// netlify/functions/_tiers.js
// 강우 단계별 소방 대응 기준 (극한호우 포함 4단계)
//
// 판정에 쓰는 값:
//   r1  = 최근 1시간 강수량 (mm)
//   r3  = 최근 3시간 누적 (mm)
//   r12 = 최근 12시간 누적 (mm)
//
// 기준표:
//   최고위험 / 극한호우 : (3시간 90mm 이상 AND 1시간 50mm 이상) 또는 1시간 72mm 이상
//   고위험   / 호우경보 : 3시간 90mm 이상 또는 12시간 180mm 이상
//   중위험   / 호우주의보: 3시간 60mm 이상 또는 12시간 110mm 이상
//   저위험   / 특보 전 단계: 3시간 30mm 이상 또는 12시간 60mm 이상

const TIERS = [
  {
    key: "extreme",
    label: "극한호우",
    trigger: "극한호우",
    color: "#8b1a4a",
    criteria: "3시간 90mm↑ + 1시간 50mm↑ 동시 충족, 또는 1시간 72mm↑ 즉시",
    actions: ["주민 즉각 대피 발령", "전 대원 현장 출동", "위험구역 접근 통제"],
    test: (r1, r3, r12) =>
      (r3 != null && r3 >= 90 && r1 != null && r1 >= 50) || (r1 != null && r1 >= 72),
  },
  {
    key: "critical",
    label: "호우경보",
    trigger: "호우경보",
    color: "#f43f5e",
    criteria: "3시간 90mm↑ 또는 12시간 180mm↑",
    actions: ["각 안전센터 현장 출동", "주민 대피 준비 통보", "유관기관 상황 공유"],
    test: (r1, r3, r12) => (r3 != null && r3 >= 90) || (r12 != null && r12 >= 180),
  },
  {
    key: "high",
    label: "호우주의보",
    trigger: "호우주의보",
    color: "#fb923c",
    criteria: "3시간 60mm↑ 또는 12시간 110mm↑",
    actions: ["위험구역 순찰 개시", "모니터링 강화", "기상청 예보 실시간 확인"],
    test: (r1, r3, r12) => (r3 != null && r3 >= 60) || (r12 != null && r12 >= 110),
  },
  {
    key: "low",
    label: "관심단계",
    trigger: "특보 전 단계",
    color: "#fbbf24",
    criteria: "3시간 30mm↑ 또는 12시간 60mm↑",
    actions: ["예찰 활동 강화", "취약지 사전 점검", "상황 대비 태세 유지"],
    test: (r1, r3, r12) => (r3 != null && r3 >= 30) || (r12 != null && r12 >= 60),
  },
];

const NORMAL = {
  key: "normal",
  label: "양호",
  trigger: "-",
  color: "#34d399",
  criteria: "-",
  actions: ["평시 모니터링"],
};

// 높은 단계부터 검사 (배열 순서가 곧 우선순위)
function classify(r1, r3, r12) {
  for (const tier of TIERS) {
    if (tier.test(r1, r3, r12)) return tier;
  }
  return NORMAL;
}

// 프론트로 내보낼 때는 test 함수를 제외한 순수 데이터만
function tiersForClient() {
  return TIERS.map(({ test, ...rest }) => rest);
}

module.exports = { TIERS, NORMAL, classify, tiersForClient };
