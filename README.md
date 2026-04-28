# 냉장고 Specific AI 웹 뷰어

1시간 윈도 단위 Specific AI 진단 결과(시계열 + CAUSE/EFFECT/ACTION 라벨)를 시각화하고,  
선택한 진단을 **App Shadow 경유**로 능동형 냉장고 에이전트에 전달하는 웹 UI입니다.

---

## 빠른 시작

```powershell
# Windows PowerShell
.\run.ps1

# 또는 bat 파일 더블클릭
run.bat
```

브라우저: **http://localhost:3000** (자동으로 열림)

---

## 전체 시스템 구조

```
┌─────────────────────────────────────────────────────────────────┐
│                        로컬 3-서비스 구성                         │
│                                                                   │
│  [Specific AI 웹뷰어]  :3000                                      │
│     │                                                             │
│     │  ① POST /api/send-diagnostic-to-agent                      │
│     │     { diagnostic: { causeCodeR, sentenceDisplay, ... } }    │
│     ▼                                                             │
│  [시뮬레이터]  :8082                                              │
│     │  POST /api/command                                          │
│     │  { action: "set_specific_ai_diagnostic",                    │
│     │    params: { diagnostic: {...} } }                          │
│     │                                                             │
│     │  ② SSE /api/events/stream                                   │
│     │     shadow_update delta { specificAiDiagnostic: {...} }     │
│     ▼                                                             │
│  [능동형 냉장고 에이전트 fridge_realtime]  :8503                  │
│     └── SPECIFIC_AI_DIAGNOSTIC 이벤트                             │
│         → 채팅 말풍선 + 진단 히스토리 push                        │
└─────────────────────────────────────────────────────────────────┘
```

### Fallback 경로

시뮬레이터(`:8082`)가 꺼진 경우 자동으로 **직접 전송** 경로로 전환됩니다.

```
웹뷰어 → server.js → fridge_realtime :8503/api/receive_specific_ai_diagnostic
```

응답 JSON의 `path` 필드로 경로를 확인할 수 있습니다.
- `"shadow"` : App Shadow 경유 성공
- `"fallback_direct"` : 시뮬레이터 미실행, 직접 전송

---

## 환경 변수

`run.ps1` 실행 전 환경 변수를 설정하거나, 시스템 환경 변수로 등록합니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 웹뷰어 서버 포트 |
| `SIMULATOR_URL` | `http://127.0.0.1:8082` | 냉장고 시뮬레이터 주소 |
| `FRIDGE_REALTIME_URL` | `http://127.0.0.1:8503` | 능동형 에이전트 주소 (fallback) |
| `FRIDGE_REALTIME_DIAGNOSTIC_SECRET` | (없음) | fallback 전송 시 인증 헤더 값 |
| `PYTHON_EXE` | `python` | 시계열 파싱용 Python 실행 경로 |

예시:
```powershell
$env:SIMULATOR_URL = "http://192.168.1.10:8082"
$env:FRIDGE_REALTIME_URL = "http://192.168.1.10:8503"
.\run.ps1
```

---

## 데이터 구조

### `/api/file-detail` 응답

```json
{
  "timeseries": {
    "time": ["2025-01-14T09:00:00", "..."],
    "r_sensor": [3.1, ...],
    "r_control": [3.0, ...],
    "f_sensor": [-18.2, ...],
    "f_control": [-18.0, ...],
    "airtemperature": [22.0, ...],
    "r_loadmanage": [...],
    "r_dooropencount": [...],
    "f_defrost_signal": [...],
    "..."
  },
  "labels": [
    {
      "window_start": "2025-01-14T09:00:00",
      "window_end":   "2025-01-14T10:00:00",
      "cause_code_R": "HIGH_LOAD_INPUT",
      "cause_example_R": "뜨거운 물건이 들어와서",
      "effect_R": "TEMP_COOLING_DOWN",
      "effect_example_R": "내부 온도가 일시적으로 상승했습니다",
      "action_R": "COMPRESSOR_HIGH",
      "action_example_R": "냉각을 강화하고 있습니다",
      "cause_code_F": "NORMAL",
      "cause_example_F": "정상",
      "effect_F": "NORMAL", "effect_example_F": "...",
      "action_F": "DIAG_NORMAL", "action_example_F": "...",
      "human_match": "O"
    }
  ]
}
```

### `specificAiDiagnostic` 스펙 (App Shadow 필드)

웹뷰어의 `labels[]` 항목은 `server.js`의 `buildSpecificAiDiagnostic()` 함수를 통해 아래 스펙으로 변환됩니다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `windowStart` / `windowEnd` | string | 구간 ISO8601 |
| `causeCodeR` / `causeCodeF` | string | 냉장/냉동 CAUSE 코드 |
| `effectCodeR/F`, `effectExampleR/F` | string | EFFECT 코드·예시 |
| `actionCodeR/F`, `actionExampleR/F` | string | ACTION 코드·예시 |
| `sentenceDisplay` | string | 통합 진단 문장 (UI 표시용) |
| `modelVersion` | string | 예: `"v2"` |
| `updatedAt` | string | 전송 시각 ISO8601 |

---

## 파일 구성

```
export_fridge_specific_ai_web/
├── server.js                  # Node Express 서버 (API + App Shadow 통신)
├── web_api_timeseries.py      # Python: parquet → 시계열 JSON 변환
├── label_mapping.py           # CAUSE/EFFECT/ACTION 코드 → 한국어 매핑
├── public/
│   ├── index.html             # 메인 UI
│   └── app.js                 # 차트, 라벨 테이블, 전송 로직
├── sample_data/parquet/       # 테스트용 냉장고 시계열 데이터 (20개)
├── features_1h.parquet        # v2 모델 학습 피처 (1시간 집계)
├── human_labels_1h_fixed.csv  # 전문가 라벨 (정답 데이터)
├── v2/artifacts/              # v2 ML 모델 (.pkl)
├── run.ps1                    # Windows 실행 스크립트
└── run.bat                    # bat 래퍼
```

---

## 실행 순서 (3개 서비스 모두 사용 시)

```
1. 시뮬레이터 실행
   cd SmartOvenFridgeAgent
   .\.venv\Scripts\python.exe simulator_fridge/nicegui_app.py
   → http://localhost:8082

2. 능동형 에이전트 실행
   cd SmartOvenFridgeAgent
   .\.venv\Scripts\python.exe src/ui/fridge_realtime.py
   → http://localhost:8503

3. Specific AI 웹뷰어 실행
   cd export_fridge_specific_ai_web
   .\run.ps1
   → http://localhost:3000
```

---

## 진단 전송 흐름 (상세)

1. 웹뷰어에서 파일 선택 → "라벨 조회" 클릭
2. 라벨 테이블에서 원하는 1시간 구간 행 선택 (또는 첫 행 자동 선택)
3. **"Send → 능동형 Agent"** 버튼 클릭
4. `app.js` → `getSelectedLabelObject()` 로 선택 행의 전체 라벨 객체 추출
5. `POST /api/send-diagnostic-to-agent { diagnostic: <전체 라벨> }`
6. `server.js` → `buildSpecificAiDiagnostic()` 로 App Shadow 스펙 변환
7. 시뮬레이터 `POST /api/command { action: "set_specific_ai_diagnostic" }` 전달
8. 시뮬레이터 shadow 갱신 → SSE delta → `fridge_realtime` 수신
9. 능동형 에이전트 채팅창에 진단 결과 표시

---

## 관련 문서

- [App Shadow Specific AI 스펙](../SmartOvenFridgeAgent/docs/fridge/FRIDGE_APP_SHADOW_SPECIFIC_AI.md)
- [시뮬레이터 문서](../SmartOvenFridgeAgent/docs/fridge/FRIDGE_SIMULATOR.md)
- [App Shadow 필드 목록](../SmartOvenFridgeAgent/docs/fridge/FRIDGE_APP_SHADOW_FIELDS_USED.md)

---

## 업데이트 이력

| 날짜 | 내용 |
|------|------|
| 2026-04-28 | App Shadow 경유 통신 구조로 개선 (단순 문자열 → 전체 진단 구조체) |
| 2026-04-27 | 초기 버전: v2 ML 모델, 시계열 차트, 직접 전송 |
