const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { parse } = require("csv-parse/sync");
const { spawn } = require("child_process");

const app = express();
const BASE_PORT = Number(process.env.PORT || 3000);

const BASE_DIR = __dirname;
const HUMAN_LABELS_FIXED = path.join(BASE_DIR, "human_labels_1h_fixed.csv");
const PYTHON_SCRIPT = path.join(BASE_DIR, "web_api_timeseries.py");
const FRIDGE_REALTIME_URL =
  (process.env.FRIDGE_REALTIME_URL || "http://127.0.0.1:8503").replace(/\/$/, "");
const FRIDGE_REALTIME_DIAGNOSTIC_SECRET =
  process.env.FRIDGE_REALTIME_DIAGNOSTIC_SECRET || "";
const SIMULATOR_URL =
  (process.env.SIMULATOR_URL || "http://127.0.0.1:8082").replace(/\/$/, "");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(BASE_DIR, "public")));

/**
 * JSON POST 요청 — 타임아웃 지원.
 * @param {string}  targetUrl
 * @param {object}  bodyObj
 * @param {number}  [timeoutMs=8000] 응답 대기 최대 시간 (ms)
 */
function postJsonToAgent(targetUrl, bodyObj, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const payload = JSON.stringify(bodyObj);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const port = u.port || (isHttps ? 443 : 80);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    };
    if (FRIDGE_REALTIME_DIAGNOSTIC_SECRET) {
      headers["X-Diagnostic-Secret"] = FRIDGE_REALTIME_DIAGNOSTIC_SECRET;
    }
    const req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: u.pathname || "/",
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (resp) => {
        let chunks = "";
        resp.on("data", (c) => { chunks += c.toString("utf8"); });
        resp.on("end", () => {
          let json = {};
          try { json = JSON.parse(chunks || "{}"); } catch (_) { json = { raw: chunks }; }
          resolve({ status: resp.statusCode || 500, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload, "utf8");
    req.end();
  });
}

/**
 * 재시도 포함 postJsonToAgent.
 * @param {string}  url
 * @param {object}  body
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=8000]
 * @param {number}  [opts.retries=2]       최대 시도 횟수 (첫 시도 포함)
 * @param {number}  [opts.retryDelayMs=1500] 재시도 간격
 */
async function postWithRetry(url, body, { timeoutMs = 8000, retries = 2, retryDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await postJsonToAgent(url, body, timeoutMs);
      return result;
    } catch (e) {
      lastErr = e;
      console.warn(`[server.js] POST ${url} 시도 ${attempt}/${retries} 실패: ${e.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastErr;
}

// 파일 목록 API: human_labels_1h_fixed.csv에서 source_path만 유일하게 추출
app.get("/api/files", (req, res) => {
  try {
    const seen = new Set();
    const files = [];

    // CSV 기반 source_path 수집
    if (fs.existsSync(HUMAN_LABELS_FIXED)) {
      const csvText = fs.readFileSync(HUMAN_LABELS_FIXED, { encoding: "utf-8" });
      const records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
      });
      for (const row of records) {
        const sp = row.source_path;
        if (!sp) continue;
        if (!seen.has(sp)) {
          seen.add(sp);
          files.push({ source_path: sp });
        }
      }
    }

    // 보기 좋게 정렬 (파일명 기준)
    files.sort((a, b) => {
      const an = a.source_path.split(/[/\\]/).pop() || "";
      const bn = b.source_path.split(/[/\\]/).pop() || "";
      return an.localeCompare(bn, "ko");
    });

    res.json({ files });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_load_files", detail: String(e) });
  }
});

// 특정 파일의 시계열 + 라벨 요약 API (Python 스크립트 호출, 라벨은 v2 모델만)
// 쿼리: source_path (필수)
app.get("/api/file-detail", (req, res) => {
  const sourcePath = req.query.source_path;
  if (!sourcePath) {
    return res.status(400).json({ error: "missing_source_path" });
  }

  const args = ["-X", "utf8", PYTHON_SCRIPT, sourcePath];
  const pythonCmd = process.env.PYTHON_EXE || "python";
  const py = spawn(pythonCmd, args, {
    cwd: BASE_DIR,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });

  let out = "";
  let err = "";
  py.stdout.on("data", (data) => {
    out += data.toString("utf8");
  });
  py.stderr.on("data", (data) => {
    err += data.toString("utf8");
  });
  py.on("close", (code) => {
    if (code !== 0) {
      console.error("python error:", err);
      return res
        .status(500)
        .json({ error: "python_failed", code, detail: err.trim() });
    }
    try {
      const payload = JSON.parse(out);
      res.json(payload);
    } catch (e) {
      console.error("json parse error:", e, out);
      res.status(500).json({ error: "invalid_json_from_python" });
    }
  });
});

/**
 * labels[] 항목(웹뷰어 라벨 필드) → App Shadow specificAiDiagnostic 스펙 객체로 변환.
 * sentenceDisplay 우선순위: explicit > 조합 문장 > causeCode 원문.
 */
function buildSpecificAiDiagnostic(label) {
  const causeR = (label.cause_code_R || label.cause_code || "").trim();
  const causeF = (label.cause_code_F || "").trim();

  // sentenceDisplay 결정
  let sentenceDisplay = (label.sentenceDisplay || label.sentenceText || "").trim();
  if (!sentenceDisplay) {
    const isNormal = causeR === "NORMAL" && (!causeF || causeF === "NORMAL");
    if (isNormal) {
      sentenceDisplay = "현재 제품은 정상 동작 중이며, 진단 결과 이상 없습니다.";
    } else {
      const parts = [];
      if (label.cause_example_R || label.effect_example_R || label.action_example_R) {
        parts.push(`냉장실: ${[label.cause_example_R, label.effect_example_R, label.action_example_R].filter(Boolean).join(" / ")}`);
      }
      if (label.cause_example_F || label.effect_example_F || label.action_example_F) {
        parts.push(`냉동실: ${[label.cause_example_F, label.effect_example_F, label.action_example_F].filter(Boolean).join(" / ")}`);
      }
      sentenceDisplay = parts.join("\n") || causeR || causeF || "진단 정보 없음";
    }
  }

  return {
    windowStart:    label.window_start  || "",
    windowEnd:      label.window_end    || "",
    causeCodeR:     causeR,
    causeCodeF:     causeF,
    effectCodeR:    label.effect_R      || "",
    effectExampleR: label.effect_example_R || "",
    actionCodeR:    label.action_R      || "",
    actionExampleR: label.action_example_R || "",
    effectCodeF:    label.effect_F      || "",
    effectExampleF: label.effect_example_F || "",
    actionCodeF:    label.action_F      || "",
    actionExampleF: label.action_example_F || "",
    sentenceDisplay,
    modelVersion:   label.modelVersion  || "v2",
    updatedAt:      new Date().toISOString(),
  };
}

/**
 * App Shadow 경로: 시뮬레이터에 set_specific_ai_diagnostic 명령 전송
 * → 시뮬레이터가 shadow 갱신 → SSE delta → fridge_realtime 처리
 *
 * body: { diagnostic: <label 객체> }
 *       또는 하위 호환용 { message: "문자열" }
 */
app.post("/api/send-diagnostic-to-agent", async (req, res) => {
  const body = req.body || {};

  // ── 구조화 경로 (App Shadow) ──────────────────────────────
  if (body.diagnostic && typeof body.diagnostic === "object") {
    const diagSpec = buildSpecificAiDiagnostic(body.diagnostic);
    const simTarget = `${SIMULATOR_URL}/api/command`;
    const simPayload = { action: "set_specific_ai_diagnostic", params: { diagnostic: diagSpec } };

    console.log(`[server.js] ▶ App Shadow 경로 시도: POST ${simTarget}`);
    console.log(`[server.js]   causeCodeR=${diagSpec.causeCodeR} causeCodeF=${diagSpec.causeCodeF}`);

    try {
      const { status, json } = await postWithRetry(simTarget, simPayload, {
        timeoutMs: 8000, retries: 2, retryDelayMs: 1500,
      });
      if (status < 400) {
        console.log(`[server.js] ✅ 시뮬레이터 수신 확인 (status=${status}):`, json);
        return res.json({ ok: true, path: "shadow", diagnostic: diagSpec });
      }
      console.warn(`[server.js] ⚠ 시뮬레이터 오류 응답 (status=${status}), fallback으로 전환:`, json);
    } catch (e) {
      console.warn(`[server.js] ✗ 시뮬레이터 연결 실패 (재시도 2회), fallback으로 전환: ${e.message}`);
    }

    // fallback: fridge_realtime 직접 전송 (시뮬레이터 미실행 환경)
    console.log(`[server.js] ↘ Fallback: POST ${FRIDGE_REALTIME_URL}/api/receive_specific_ai_diagnostic`);
    const message = diagSpec.sentenceDisplay;
    const target = `${FRIDGE_REALTIME_URL}/api/receive_specific_ai_diagnostic`;
    try {
      const { status, json } = await postJsonToAgent(target, { message, diagnostic: diagSpec });
      return res.status(status >= 400 ? status : 200).json(
        Object.assign({ path: "fallback_direct" }, json && typeof json === "object" ? json : { ok: status < 400 })
      );
    } catch (e2) {
      return res.status(502).json({
        ok: false, error: "both_unreachable",
        detail: String(e2 && e2.message ? e2.message : e2),
        hint: `SIMULATOR_URL=${SIMULATOR_URL} 또는 FRIDGE_REALTIME_URL=${FRIDGE_REALTIME_URL} 을 확인하세요.`,
      });
    }
  }

  // ── 하위 호환: 문자열 message만 온 경우 (직접 전송) ──────
  const message = body.message != null ? String(body.message).trim() : "";
  if (!message) {
    return res.status(400).json({ ok: false, error: "missing_diagnostic_or_message" });
  }
  const target = `${FRIDGE_REALTIME_URL}/api/receive_specific_ai_diagnostic`;
  try {
    const { status, json } = await postJsonToAgent(target, { message });
    res.status(status >= 400 ? status : 200).json(
      json && typeof json === "object" ? json : { ok: status < 400 }
    );
  } catch (e) {
    console.error("send-diagnostic-to-agent (legacy):", e);
    res.status(502).json({
      ok: false,
      error: "agent_unreachable",
      detail: String(e && e.message ? e.message : e),
      hint: `FRIDGE_REALTIME_URL=${FRIDGE_REALTIME_URL} 에 fridge_realtime.py 가 떠 있는지 확인하세요.`,
    });
  }
});

function startServer(port, attemptsLeft = 20) {
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`Port ${port} is in use. Trying ${port + 1}...`);
      server.close(() => startServer(port + 1, attemptsLeft - 1));
      return;
    }
    console.error(err);
    process.exit(1);
  });
  return server;
}

startServer(BASE_PORT);

