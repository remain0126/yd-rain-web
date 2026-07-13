# 영덕 강우 감시 (모바일 PWA)

영덕군 관내 읍면 실시간 강우량과 119안전센터별 위험도를 모바일에서 보는
PWA(홈화면 추가 시 앱처럼 동작) 웹앱입니다. Netlify에 그대로 올리면 배포됩니다.

## 구조

```
yd-rain-web/
├─ netlify.toml               # Netlify 빌드/리다이렉트 설정
├─ package.json               # 함수 의존성(cheerio)
├─ netlify/functions/
│   └─ rainfall.js            # 영덕군청 페이지를 긁어 JSON 반환하는 서버리스 함수
└─ public/                    # 정적 프론트엔드 (그대로 배포됨)
    ├─ index.html
    ├─ style.css
    ├─ app.js
    ├─ manifest.webmanifest   # PWA 설정
    ├─ sw.js                  # 서비스 워커 (앱 셸 캐시)
    └─ icons/                 # 앱 아이콘 192/512
```

## 동작 방식

- **주기 수집(scheduled-refresh.js)**: Netlify 예약 함수가 **5분마다** 자동 실행되어
  영덕군청 페이지를 미리 긁어와 Netlify Blobs(키-값 저장소)에 저장한다.
- **접속 응답(rainfall.js)**: 사용자가 `/api/rainfall`을 호출하면 영덕군청을 직접
  기다리지 않고 **저장소의 최신본을 즉시 반환**한다 → 초기 접속도 빠름.
  (배포 직후 저장본이 아직 없으면 그 1회만 직접 긁어와 저장)
- **브라우저 저장**: 프론트가 마지막 성공 데이터를 localStorage에 저장. 재방문 시
  저장본을 먼저 즉시 그린 뒤 백그라운드로 최신을 받아 교체 → 체감 즉시.
- 공용 스크래핑/파싱 로직은 `netlify/functions/_scrape.js`에 모아 두 함수가 공유.

> 예약 함수는 `scheduled-refresh.js` 안의 `exports.config = { schedule: "*/5 * * * *" }`
> 로 5분 주기가 지정되며 Netlify가 배포 시 자동 인식한다.

## 데이터 경로(구버전 설명)

- 브라우저(프론트) → `/api/rainfall` 호출
- `netlify.toml`이 이를 서버리스 함수 `netlify/functions/rainfall.js`로 연결
- 함수가 영덕군청 `https://www.yd.go.kr/?p=1020`을 서버 측에서 긁어와 파싱 후 JSON 반환
  (브라우저에서 직접 긁으면 CORS로 막히므로 함수가 대행)
- 함수 응답은 5분 캐시. 프론트는 5분마다 자동 새로고침 + 수동 새로고침 버튼

> 로컬 PC(영덕소방서 내부망)에서는 SSL 검사 장비 때문에 `verify=False`가 필요했지만,
> Netlify 서버는 외부에 있어 그 문제가 없습니다. 다만 영덕군청이 외부 IP의 자동 접속을
> 차단할 가능성은 배포 후 실제로 함수를 호출해봐야 확인됩니다 (아래 5번 참고).

## 배포 방법 (가장 쉬운 순서)

### 방법 A. Netlify 웹에서 드래그 앤 드롭 (가장 간단, 함수 포함)

1. https://app.netlify.com 로그인 → "Add new site" → "Deploy manually"
2. 이 폴더(`yd-rain-web`) 전체를 드래그해서 올립니다.
   - `netlify.toml`이 있으므로 함수(`netlify/functions`)와 정적 파일(`public`)이 자동 인식됩니다.
3. 배포되면 `https://무작위이름.netlify.app` 주소가 생성됩니다.
4. 사이트 이름은 Site settings → Change site name 에서 원하는 이름으로 변경 가능.

### 방법 B. GitHub 연동 (지속 업데이트에 유리)

1. 이 폴더를 GitHub 저장소로 push
2. Netlify → "Add new site" → "Import from Git" → 저장소 선택
3. 빌드 설정은 `netlify.toml`이 자동 적용 (publish=public, functions=netlify/functions)

## 배포 후 확인

1. 배포된 주소 접속 → 센터 현황/읍면 순위가 뜨는지 확인
2. 함수만 따로 테스트: `https<배포주소>/api/rainfall` 직접 열어서 JSON이 나오는지 확인
   - JSON이 나오면 성공
   - `{"error": ...}`가 나오면 영덕군청이 외부 접속을 막은 것 → 아래 참고

## 5. 영덕군청이 외부 접속을 차단하는 경우

함수가 `error`를 반환하면(예: 403, 타임아웃), 영덕군청 서버가 외부 자동접속을
막고 있는 것입니다. 이 경우 선택지:

- **정공법(권장):** 영덕군청 안전건설과에 "예방안전과 산사태 모니터링용으로
  강우 데이터 연계"를 정식 요청. API나 파일 피드를 받으면 함수에서 그걸 쓰도록 교체.
- 임시: 함수의 User-Agent/헤더 조정으로 우회가 될 수도 있으나 안정적이지 않음.

## 홈 화면에 앱처럼 추가 (PWA)

- **아이폰(사파리):** 공유 → "홈 화면에 추가"
- **안드로이드(크롬):** 메뉴 → "홈 화면에 추가" / "앱 설치"
- 추가하면 주소창 없는 전체화면으로 열리고, 아이콘도 표시됩니다.

## yd-fire 통합 (나중에)

독립 사이트로 잘 돌아가는 걸 확인한 뒤, 기존 yd-fire에 붙이려면:
- 가장 간단: yd-fire에서 이 사이트로 가는 버튼/링크 추가
- 더 통합: 이 `rainfall.js` 함수를 yd-fire의 Netlify 프로젝트로 옮기고,
  강우 화면을 yd-fire 안의 탭/패널로 임베드
