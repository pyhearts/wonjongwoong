# 매크로 교육용 자료 — 설정 가이드

이 폴더는 "매크로 완전 이해" 수업에 쓰인 자료를 공유용으로 정리한 것입니다.
별도 실습 사이트를 운영하려면 **본인 소유의 Firebase 프로젝트와 Cloudflare Worker**를 만들고
아래 설정을 해당 프로젝트 값으로 바꾸세요. wrangler deploy --config ./wrangler.jsonc

## 폴더 구성

```
index.html        - 좌석 예매 게임 페이지 (Firebase 클라이언트 SDK 사용)
worker.js         - Cloudflare Worker (좌석 등록 API, Firebase에 직접 씀)
wrangler.jsonc    - Cloudflare Workers 배포 설정
macro/            - 매크로 실습 예제 3종 (V1 좌표 / V2 이미지 / V3 태그 기반)
macro_guide.txt   - 매크로 원리 + CSS 셀렉터 실습 가이드 (수업 자료)
requirements.txt  - 매크로 실행에 필요한 파이썬 패키지 목록
```

## 1. Firebase 프로젝트 만들기

1. [Firebase 콘솔](https://console.firebase.google.com)에서 새 프로젝트 생성
2. **Realtime Database**를 생성하고 아래 보안 규칙을 게시하세요.
3. **Authentication → 로그인 방법**에서 참가자용 **Google**을 활성화하고 지원 이메일을
   지정하세요. 관리자용 **이메일/비밀번호**를 활성화하고 관리자 계정을 생성하세요.
   **Authentication → 설정 → 승인된 도메인**에 실제 Worker 호스트 이름을 추가하세요.
4. **프로젝트 설정 > 일반 > 내 앱**에서 웹 앱을 추가하면 `firebaseConfig` 객체가
   나옵니다. 이 값을 [index.html](index.html)의 `firebaseConfig` 부분에 그대로
   붙여넣으세요.
5. [index.html](index.html)과 [wrangler.jsonc](wrangler.jsonc)의 `ADMIN_EMAIL`을 3번에서
   만든 관리자 이메일로 바꾸세요.
6. [wrangler.jsonc](wrangler.jsonc)의 `FIREBASE_DB_URL`, `FIREBASE_PROJECT_ID`,
   `FIREBASE_API_KEY`를 같은 Firebase 프로젝트의 데이터베이스 주소, 프로젝트 ID,
   웹 API 키로 맞추세요.
7. Realtime Database용 **비밀 키(Database Secret)**를 발급받으세요
   (프로젝트 설정 > 서비스 계정 > 데이터베이스 보안 비밀). 이 값은 절대
   코드에 직접 적지 말고 아래 3단계에서 Cloudflare Secret으로만 등록합니다.

## 2. Cloudflare Workers 배포

1. Cloudflare 계정 생성 후 `npm install -g wrangler`, `wrangler login`
2. `wrangler kv:namespace create RATE_LIMIT` 실행 → 발급된 id를
   [wrangler.jsonc](wrangler.jsonc)의 `id` 자리에 채우기
3. Cloudflare 대시보드에서 확인한 `account_id`를 [wrangler.jsonc](wrangler.jsonc)에 채우기
4. Cloudflare 대시보드의 **Turnstile**에서 새 위젯을 만들고, 실제 Worker 호스트 이름을
   등록하세요. 필요할 때만 체크박스를 표시하려면 **Managed** 모드를 선택하세요.
   발급된 공개 사이트 키는 [wrangler.jsonc](wrangler.jsonc)의 `TURNSTILE_SITE_KEY`에 입력하세요.
5. Firebase Database Secret과 Turnstile 비밀 키를 Worker Secret으로 등록하세요.
   ```bash
   wrangler secret put FIREBASE_SECRET --config ./wrangler.jsonc
   wrangler secret put TURNSTILE_SECRET_KEY --config ./wrangler.jsonc
   ```
6. 프로젝트 폴더에서 다음 명령으로 배포하세요. `--config`는 상위 폴더에 Wrangler 설정이 있어도 이 프로젝트의 설정을 사용합니다.
   ```bash
   wrangler deploy --config ./wrangler.jsonc
   ```
   배포 로그에 `macro-classroom`이 표시되면 해당 Worker 주소에서 Google 로그인, 계정 설정 저장,
   좌석 신청, 관리자 Start/Stop/Reset을 확인하세요.

이미 배포한 사이트에 기능을 추가하는 경우에도 Firebase의 Google 제공자와 승인된 도메인,
아래 데이터베이스 규칙, Turnstile 위젯과 키를 설정해야 합니다.

참가자는 로그인한 뒤 계정 설정에서 닉네임과 좌석 색상을 저장하고, 좌석별로 Turnstile 확인을
거쳐 신청합니다. 닉네임과 색상 변경은 이후 신청하는 좌석부터 적용됩니다.

## 3. 매크로 스크립트에 사이트 주소 반영

`macro/macro_v1_coordinate.py`, `macro_v2_image.py`, `macro_v3_tag.py` 상단의
```python
SITE_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev/"
```
를 2단계에서 배포한 실제 주소로 바꾸세요.
이 예제들은 Google 로그인과 Turnstile을 추가하기 전 화면을 기준으로 작성됐습니다.

## 4. Firebase 보안 규칙 점검 (중요)

Firebase 콘솔의 **Realtime Database → 규칙**에서 아래 규칙을 게시하세요. 공개 읽기는
좌석과 게임 상태에만 허용합니다. 계정 설정과 쓰기 요청은 Worker가 인증 후 처리합니다.
다른 기능의 규칙을 병합하는 경우 상위 경로의 규칙이 아래 경로에 읽기나 쓰기를 허용하는지
확인하세요.

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "seats": { ".read": true, ".write": false },
    "gameActive": { ".read": true, ".write": false },
    "profiles": { ".read": false, ".write": false }
  }
}
```

기존 `gameActive` 쓰기 규칙이 `auth != null`이면 Google 로그인 사용자도 상태를 변경할 수
있으므로 새 규칙으로 교체하세요.

## 5. 설치 및 실행

```bash
pip install -r requirements.txt
python macro/macro_v1_coordinate.py
python macro/macro_v2_image.py
python macro/macro_v3_tag.py
```

또는 `macro/install.bat`으로 Python + 패키지를 한 번에 설치할 수 있습니다.

수업 진행 방식과 매크로 원리 설명은 [macro_guide.txt](macro_guide.txt)를 참고하세요.
