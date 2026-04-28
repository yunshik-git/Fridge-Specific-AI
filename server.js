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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(BASE_DIR, "public")));

function postJsonToAgent(targetUrl, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const payload = JSON.stringify(bodyObj);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const port =
      u.port || (isHttps ? 443 : 80);
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
      },
      (resp) => {
        let chunks = "";
        resp.on("data", (c) => {
          chunks += c.toString("utf8");
        });
        resp.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(chunks || "{}");
          } catch (_) {
            json = { raw: chunks };
          }
          resolve({ status: resp.statusCode || 500, json });
        });
      }
    );
    req.on("error", reject);
    req.write(payload, "utf8");
    req.end();
  });
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

// 능동형 냉장고 Agent(fridge_realtime)로 현재 진단 문장 전달
app.post("/api/send-diagnostic-to-agent", async (req, res) => {
  const message = req.body && req.body.message != null ? String(req.body.message).trim() : "";
  if (!message) {
    return res.status(400).json({ ok: false, error: "missing_message" });
  }
  const target = `${FRIDGE_REALTIME_URL}/api/receive_specific_ai_diagnostic`;
  try {
    const { status, json } = await postJsonToAgent(target, { message });
    res.status(status >= 400 ? status : 200).json(
      json && typeof json === "object" ? json : { ok: status < 400 }
    );
  } catch (e) {
    console.error("send-diagnostic-to-agent:", e);
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

