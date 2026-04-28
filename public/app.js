const API_BASE = "";
const SENTENCE_TEMPLATE = "{cause} {effect}, {action}";

const FONT_FAMILY =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo","Nanum Gothic",sans-serif';

let chartTemp;
let chartAux;
let currentTimesMs = [];
let labelRanges = [];
let highlightRange = null; // {startIndex, endIndex} inclusive
let currentSourcePath = ""; // 적용 버튼으로 다시 불러올 때 사용
let fullTimeseriesData = null;
let fullLabelsData = null;
let lastScrolledLabelIndex = -1;
let currentActiveIndex = -1;
/** 보조지표 툴팁용: 스케일 적용 전 원래 값 + dooropentime, operation_state, compowerlevel */
let lastAuxTooltipData = null;

let selectedLabelTr = null;
let displayWindowRefs = [];
let lastDisplaySentence = null;

function _sentenceHtmlToText(html) {
  if (html == null) return "";
  const div = document.createElement("div");
  div.innerHTML = String(html);
  return (div.textContent || div.innerText || "").trim();
}

function _normalizeSentenceForDisplay(raw) {
  if (raw == null) return "";
  let s = String(raw);
  // HTML 줄바꿈을 텍스트 줄바꿈으로 변환
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // HTML 엔티티/태그 제거(줄바꿈 포함 텍스트 유지)
  const div = document.createElement("div");
  div.innerHTML = s;
  s = (div.textContent || div.innerText || "").toString();

  // 줄바꿈/공백 정리
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  // 정상 문구는 항상 2줄로 보이게 강제
  if (s.includes("정상 동작 중이며") && s.includes("진단 결과") && !s.includes("\n")) {
    s = s.replace(/(정상 동작 중이며,?)\s*/g, "$1\n");
  }

  // 냉장실/냉동실 문장은 줄바꿈으로 분리
  if (s.includes("냉장실") && s.includes("냉동실") && !s.includes("\n냉동실")) {
    s = s.replace("냉동실은", "\n냉동실은");
  }

  // 문장 끝 마침표 보정
  s = s.replace(
    /필요시 설정온도를 낮추세요(?!\.)/g,
    "필요시 설정온도를 낮추세요."
  );
  s = s.replace(
    /상승했습니다,\s*(?=시간이 흐르면 정상 온도로 복귀 합니다)/g,
    "상승했습니다.\n"
  );
  s = s.replace(
    /상승했습니다\.\s*(?=시간이 흐르면 정상 온도로 복귀 합니다)/g,
    "상승했습니다.\n"
  );
  s = s.replace(
    /상승했습니다,\s*(?=냉각을 강화하고 있습니다)/g,
    "상승했습니다. "
  );
  s = s.replace(
    /냉각을 강화하고 있습니다(?!\.)/g,
    "냉각을 강화하고 있습니다."
  );

  // 냉장실 문구 보정: '냉장실은 뜨거운 물건이' -> '냉장실에 뜨거운 물건이'
  s = s.replace(/냉장실은 뜨거운 물건이/g, "냉장실에 뜨거운 물건이");

  return s;
}

function _persistAndBroadcastSentence(sentence) {
  const s = sentence || "";
  try {
    localStorage.setItem("display_sentence", s);
  } catch (_) {
    // ignore
  }
  let any = false;
  const next = [];
  for (const w of displayWindowRefs) {
    if (!w || w.closed) continue;
    try {
      w.postMessage({ type: "display_sentence", sentence: s }, location.origin);
      any = true;
      next.push(w);
    } catch (_) {
      // ignore, drop this ref
    }
  }
  displayWindowRefs = next;
  return any;
}

function previewSentenceFromRow(tr) {
  if (!tr) return;
  const sentence = (tr.dataset && tr.dataset.sentenceText) || "";
  const updatedPopup = _persistAndBroadcastSentence(sentence);
  if (!updatedPopup) {
    // 팝업이 없어도 오버레이를 자동으로 띄우지 않음.
    // 단, 오버레이가 이미 떠 있으면 내용은 갱신.
    const overlay = document.getElementById("display-overlay");
    if (overlay && overlay.classList.contains("active")) {
      updateDisplayOverlayText(sentence);
    }
  }
}

function setSelectedLabelRow(tr) {
  const container = document.getElementById("labels-container");
  if (!container || !tr) return;
  const prev = container.querySelector("tr.row-selected");
  if (prev && prev !== tr) prev.classList.remove("row-selected");
  tr.classList.add("row-selected");
  selectedLabelTr = tr;

  // 선택 시에도 동일하게 반영
  previewSentenceFromRow(tr);
  updateSendDiagnosticButton();
}

function getSentenceForDisplay() {
  const container = document.getElementById("labels-container");
  if (!container) return "";
  const selected = container.querySelector("tr.row-selected");
  const highlighted = container.querySelector("tr.row-highlight");
  const firstRow = container.querySelector("tbody tr");
  const tr = selected || highlighted || selectedLabelTr || firstRow;
  const v = tr && tr.dataset ? tr.dataset.sentenceText : "";
  return v || "";
}

function updateSendDiagnosticButton() {
  const btn = document.getElementById("btn-send-diagnostic");
  if (!btn) return;
  const has = !!(fullLabelsData && fullLabelsData.length && getSentenceForDisplay().trim());
  btn.disabled = !has;
}

async function sendDiagnosticToAgent() {
  const msg = getSentenceForDisplay().trim();
  if (!msg) return;
  const statusEl = document.getElementById("send-diagnostic-status");
  const btn = document.getElementById("btn-send-diagnostic");
  if (statusEl) statusEl.textContent = "전송 중...";
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/send-diagnostic-to-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (res.ok && data.ok !== false) {
      if (statusEl) statusEl.textContent = "전송 완료 (능동형 Agent 채팅 확인)";
    } else {
      const err = data.error || data.detail || data.hint || res.statusText || "실패";
      if (statusEl) statusEl.textContent = String(err).slice(0, 200);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = String(e.message || e);
  } finally {
    updateSendDiagnosticButton();
    setTimeout(() => {
      if (statusEl) statusEl.textContent = "";
    }, 5000);
  }
}

function showDisplayOverlay(sentence) {
  const overlay = document.getElementById("display-overlay");
  if (!overlay) return;
  const bodyEl = overlay.querySelector(".display-panel-body");
  if (bodyEl) {
    const raw = sentence && String(sentence).trim();
    const text = raw || "표시할 문장이 없습니다.";
    const special =
      text === "현재 제품은 정상 동작 중이며,\n진단 결과 이상 없습니다.";
    bodyEl.style.fontSize = special ? "30px" : "26px";
    bodyEl.textContent = text;
  }
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
}

function updateDisplayOverlayText(sentence) {
  const overlay = document.getElementById("display-overlay");
  if (!overlay) return;
  const bodyEl = overlay.querySelector(".display-panel-body");
  if (!bodyEl) return;
  const raw = sentence && String(sentence).trim();
  const text = raw || "표시할 문장이 없습니다.";
  const special =
    text === "현재 제품은 정상 동작 중이며,\n진단 결과 이상 없습니다.";
  bodyEl.style.fontSize = special ? "30px" : "26px";
  bodyEl.textContent = text;
}

function hideDisplayOverlay() {
  const overlay = document.getElementById("display-overlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
}

function makeExternalTooltip(tooltipElId) {
  const isTsPanel = tooltipElId === "ts-chart-tooltip";
  const isAuxPanel = tooltipElId === "aux-chart-tooltip";
  return function (context) {
    const el = document.getElementById(tooltipElId);
    if (!el) return;
    const { opacity, title, body, dataPoints } = context.tooltip;
    if (opacity === 0) {
      el.classList.remove("visible");
      el.innerHTML = "";
      el.setAttribute("aria-hidden", "true");
      if (isTsPanel) {
        const ph = document.getElementById("ts-chart-tooltip-placeholder");
        if (ph) ph.style.display = "";
      }
      return;
    }
    const chart = context.chart;
    const datasets = (chart && chart.data && chart.data.datasets) || [];

    let titleStr = Array.isArray(title) ? title[0] : title || "";
    let bodyHtml = "";

    if (isAuxPanel && lastAuxTooltipData) {
      const idx = dataPoints && dataPoints[0] ? dataPoints[0].dataIndex : -1;
      if (idx >= 0 && lastAuxTooltipData.indexToTime && lastAuxTooltipData.indexToTime[idx]) {
        titleStr = lastAuxTooltipData.indexToTime[idx];
      }
      const fmt = (v) => (v == null || v === "" ? "-" : String(v));
      const rows = [];
      const findSeries = (key) =>
        (lastAuxTooltipData.series || []).find((s) => s.key === key);
      const findExtra = (key) =>
        (lastAuxTooltipData.extra || []).find((e) => e.key === key);
      const colorFor = (label) => {
        const ds = (datasets || []).find((d) => (d.label || "").startsWith(label));
        const c = ds && (ds.borderColor || ds.backgroundColor);
        return typeof c === "string" ? c : (c && c[0]) || "#111827";
      };
      const pushMetric = (entry, isExtra = false) => {
        if (!entry) return;
        const val = entry.values && entry.values[idx];
        const colorStr = isExtra ? "#475569" : colorFor(entry.label);
        rows.push(
          `<div class="tt-row" style="color:${colorStr}">${entry.label}: ${fmt(val)}</div>`
        );
      };
      // 원하는 순서: 냉장 부하대응, 냉장 부하대응 차단시간, 냉장 문열림 횟수, 냉장 문열림 시간,
      //             냉동 부하대응, 냉동 제상신호, 냉동 문열림 횟수, 냉동 문열림 시간, COMP 냉력
      pushMetric(findSeries("r_load"));
      pushMetric(findSeries("r_block"));
      pushMetric(findSeries("r_door"));
      pushMetric(findExtra("r_door_time"), true);
      pushMetric(findSeries("f_load"));
      pushMetric(findSeries("f_defrost"));
      pushMetric(findSeries("f_door"));
      pushMetric(findExtra("f_door_time"), true);
      pushMetric(findExtra("comp"), true);
      bodyHtml = rows.join("");
    } else {
      bodyHtml = (body || [])
        .map((b) => {
          const di = b.datasetIndex;
          const color = datasets[di] && (datasets[di].borderColor || datasets[di].backgroundColor);
          const style = color ? ` style="color: ${typeof color === "string" ? color : (color[0] || "#111827")}"` : "";
          return (b.lines || []).map((line) => `<div class="tt-row"${style}>${line}</div>`).join("");
        })
        .join("");
    }

    el.innerHTML = `<div class="tt-title">${titleStr}</div>${bodyHtml}`;
    el.classList.add("visible");
    el.setAttribute("aria-hidden", "false");
    if (isTsPanel) {
      const ph = document.getElementById("ts-chart-tooltip-placeholder");
      if (ph) ph.style.display = "none";
    }
  };
}

const crosshairPlugin = {
  id: "crosshairLine",
  afterDraw(chart) {
    const active = chart.getActiveElements ? chart.getActiveElements() : [];
    if (!active || active.length === 0) return;
    const el = active[0].element;
    if (!el) return;
    const x = el.x;
    const { top, bottom } = chart.chartArea || {};
    if (top == null || bottom == null) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(17,24,39,0.55)";
    ctx.stroke();
    ctx.restore();
  },
};

const rangeHighlightPlugin = {
  id: "rangeHighlight",
  beforeDatasetsDraw(chart) {
    if (!highlightRange) return;
    const { startIndex, endIndex } = highlightRange;
    if (startIndex == null || endIndex == null) return;
    if (startIndex < 0 || endIndex < 0) return;
    const { top, bottom, left, right } = chart.chartArea || {};
    if ([top, bottom, left, right].some((v) => v == null)) return;
    const xScale = chart.scales?.x;
    if (!xScale) return;

    const x0 = xScale.getPixelForValue(startIndex);
    const x1 = xScale.getPixelForValue(endIndex);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);

    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(37, 99, 235, 0.12)";
    ctx.strokeStyle = "rgba(37, 99, 235, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(lo, top, hi - lo, bottom - top);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
};

function _parseIsoToMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function getRowElements(r) {
  return r.trs ? r.trs : r.tr ? [r.tr] : [];
}

function clearLabelHighlight() {
  for (const r of labelRanges) {
    getRowElements(r).forEach((el) => el.classList.remove("row-highlight"));
  }
}

function highlightLabelForTimeMs(tMs) {
  if (!Number.isFinite(tMs)) {
    clearLabelHighlight();
    lastScrolledLabelIndex = -1;
    return;
  }
  let any = false;
  let firstHitIndex = -1;
  labelRanges.forEach((r, idx) => {
    const hit = tMs >= r.startMs && tMs < r.endMs;
    getRowElements(r).forEach((el) => el.classList.toggle("row-highlight", hit));
    if (hit) {
      any = true;
      if (firstHitIndex === -1) firstHitIndex = idx;
    }
  });
  if (!any) {
    clearLabelHighlight();
    lastScrolledLabelIndex = -1;
    return;
  }
  if (firstHitIndex !== -1 && firstHitIndex !== lastScrolledLabelIndex) {
    const r = labelRanges[firstHitIndex];
    const els = getRowElements(r);
    if (els.length > 0 && typeof els[0].scrollIntoView === "function") {
      try {
        els[0].scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {
        els[0].scrollIntoView();
      }
    }
    lastScrolledLabelIndex = firstHitIndex;
  }
}

function setActiveIndex(chart, index) {
  if (!chart) return;
  if (index == null || index < 0) {
    chart.setActiveElements([]);
    if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update("none");
    return;
  }
  const elems = chart.data.datasets.map((_, di) => ({ datasetIndex: di, index }));
  chart.setActiveElements(elems);
  try {
    const meta0 = chart.getDatasetMeta(0);
    const pt = meta0?.data?.[index];
    const x = pt?.x ?? 0;
    const y = pt?.y ?? 0;
    if (chart.tooltip) chart.tooltip.setActiveElements(elems, { x, y });
  } catch (_) {
    // ignore
  }
  chart.update("none");
}

function syncHover(index) {
  const tMs = currentTimesMs[index];
  // 마우스 위치가 속한 1시간 구간(라벨 요약과 동일)을 찾아 차트에 영역으로 표시
  let rangeForChart = null;
  for (const r of labelRanges) {
    if (Number.isFinite(tMs) && tMs >= r.startMs && tMs < r.endMs) {
      rangeForChart = r;
      break;
    }
  }
  if (rangeForChart) {
    setHighlightRangeByMs(rangeForChart.startMs, rangeForChart.endMs);
  } else {
    highlightRange = null;
    if (chartTemp) chartTemp.update("none");
    if (chartAux) chartAux.update("none");
  }
  currentActiveIndex = index;
  setActiveIndex(chartTemp, index);
  setActiveIndex(chartAux, index);
  highlightLabelForTimeMs(tMs);

  // 차트 호버와 연동되는 1시간 구간 라벨의 sentence를 디스플레이(열려있는 팝업)에 전송
  let sentence = "";
  if (rangeForChart) {
    const els = getRowElements(rangeForChart);
    const tr = els && els[0];
    sentence = (tr && tr.dataset && tr.dataset.sentenceText) || "";
  }
  if (sentence !== lastDisplaySentence) {
    lastDisplaySentence = sentence;
    const updatedPopup = _persistAndBroadcastSentence(sentence);
    if (!updatedPopup) {
      const overlay = document.getElementById("display-overlay");
      if (overlay && overlay.classList.contains("active")) {
        updateDisplayOverlayText(sentence);
      }
    }
  }
}

function findFirstIndexGE(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (!Number.isFinite(v)) {
      lo = mid + 1;
      continue;
    }
    if (v >= target) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans === arr.length ? -1 : ans;
}

function findLastIndexLT(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (!Number.isFinite(v)) {
      lo = mid + 1;
      continue;
    }
    if (v < target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function setHighlightRangeByMs(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !currentTimesMs.length) {
    highlightRange = null;
    if (chartTemp) chartTemp.update("none");
    if (chartAux) chartAux.update("none");
    return;
  }
  const s = findFirstIndexGE(currentTimesMs, startMs);
  const e = findLastIndexLT(currentTimesMs, endMs);
  if (s < 0 || e < 0 || e < s) {
    highlightRange = null;
    if (chartTemp) chartTemp.update("none");
    if (chartAux) chartAux.update("none");
    return;
  }
  highlightRange = { startIndex: s, endIndex: e };
  if (chartTemp) chartTemp.update("none");
  if (chartAux) chartAux.update("none");
}

function formatSentence(causeExample, effectExample, actionExample) {
  const c = (causeExample || "").toString().trim();
  const e = (effectExample || "").toString().trim();
  const a = (actionExample || "").toString().trim();
  if (!c && !e && !a) return "";

  const first = [c, e].filter(Boolean).join(" ").trim();
  if (!a) return first;
  if (!first) return a;
  const needsComma = !/[.,!?。]\s*$/.test(first);
  return `${first}${needsComma ? "," : ""} ${a}`.trim();
}

function formatSentenceByCauseCode(causeCode, causeExample, effectExample, actionExample) {
  const code = (causeCode || "").toString().trim().toUpperCase();
  if (code === "NORMAL") return "정상 동작 상태입니다.";
  return formatSentence(causeExample, effectExample, actionExample);
}

async function fetchFiles() {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "서버에서 파일 목록을 불러오는 중...";
  try {
    const res = await fetch(`${API_BASE}/api/files`);
    const data = await res.json();
    const tbody = document.getElementById("file-tbody");
    tbody.innerHTML = "";
    (data.files || []).forEach((f, idx) => {
      const tr = document.createElement("tr");
      tr.dataset.sourcePath = f.source_path;
      tr.innerHTML = `<td title="${f.source_path}">${idx + 1}. ${f.source_path.split(/[/\\\\]/).pop()}</td>`;
      tr.addEventListener("click", () => onFileClick(tr));
      tbody.appendChild(tr);
    });
    statusEl.textContent = `총 ${(data.files || []).length}개 파일`;
  } catch (e) {
    console.error(e);
    statusEl.textContent = "파일 목록 로드 실패";
  }
}

async function loadFileDetail(sourcePath) {
  const currentFileEl = document.getElementById("current-file");
  currentFileEl.textContent = `- ${sourcePath.split(/[/\\\\]/).pop()}`;
  const statusEl = document.getElementById("status");
  statusEl.textContent = "시계열 및 라벨 로드 중...";
  const url = `${API_BASE}/api/file-detail?source_path=${encodeURIComponent(sourcePath)}`;
  const res = await fetch(url);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(e);
    statusEl.textContent = "서버 응답(JSON) 파싱 실패";
    return;
  }
  if (!res.ok) {
    const detail =
      (data && (data.detail || data.error)) ? String(data.detail || data.error) : res.statusText;
    statusEl.textContent = `로드 실패: ${detail}`;
    fullTimeseriesData = { time: [] };
    fullLabelsData = [];
    updateTimeRangeInputsFromData(fullTimeseriesData);
    applyTimeRangeAndRender();
    updateSendDiagnosticButton();
    return;
  }
  fullTimeseriesData = data.timeseries || {};
  fullLabelsData = Array.isArray(data.labels) ? data.labels : [];
  // 반드시 구간 입력을 새 데이터 기준으로 맞춘 뒤 렌더링해야 함.
  // 이전 파일의 ts-range 값으로 필터하면 새 시계열이 전부 걸러져 차트가 비어 보임.
  updateTimeRangeInputsFromData(fullTimeseriesData);
  applyTimeRangeAndRender();
  statusEl.textContent = "완료";
  updateSendDiagnosticButton();
}

function updateTimeRangeInputsFromData(ts) {
  const times = ts.time || [];
  const startEl = document.getElementById("ts-range-start");
  const endEl = document.getElementById("ts-range-end");
  if (times.length === 0) {
    if (startEl) startEl.value = "";
    if (endEl) endEl.value = "";
    return;
  }
  const first = times[0];
  const last = times[times.length - 1];
  const toDatetimeLocal = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day}T${h}:${min}`;
  };
  if (startEl) {
    startEl.value = toDatetimeLocal(first);
    startEl.min = first ? String(first).slice(0, 16) : "";
    startEl.max = last ? String(last).slice(0, 16) : "";
  }
  if (endEl) {
    endEl.value = toDatetimeLocal(last);
    endEl.min = first ? String(first).slice(0, 16) : "";
    endEl.max = last ? String(last).slice(0, 16) : "";
  }
}

function applyTimeRangeAndRender() {
  if (fullTimeseriesData == null || fullLabelsData == null) return;
  const startEl = document.getElementById("ts-range-start");
  const endEl = document.getElementById("ts-range-end");
  let startMs = null;
  let endMs = null;
  if (startEl && startEl.value) startMs = new Date(startEl.value).getTime();
  if (endEl && endEl.value) endMs = new Date(endEl.value).getTime();
  const ts = filterTimeseriesByRange(fullTimeseriesData, startMs, endMs);
  const labels = filterLabelsByRange(fullLabelsData, startMs, endMs);
  renderLabels(labels);
  // 차트 호버에서 labelRanges를 사용하므로 라벨을 먼저 렌더링
  renderCharts(ts);
  updateSendDiagnosticButton();
}

function filterTimeseriesByRange(ts, startMs, endMs) {
  const times = ts.time || [];
  if (times.length === 0) return ts;
  if (startMs == null && endMs == null) return ts;
  const indices = [];
  for (let i = 0; i < times.length; i++) {
    const t = _parseIsoToMs(times[i]);
    if (t == null) continue;
    if (startMs != null && t < startMs) continue;
    if (endMs != null && t > endMs) continue;
    indices.push(i);
  }
  const slice = (arr) => (Array.isArray(arr) ? indices.map((i) => arr[i]) : arr);
  return {
    time: slice(ts.time),
    r_sensor: slice(ts.r_sensor),
    r_control: slice(ts.r_control),
    f_sensor: slice(ts.f_sensor),
    f_control: slice(ts.f_control),
    airtemperature: slice(ts.airtemperature),
    r_loadmanage: slice(ts.r_loadmanage),
    r_loadmanageblockingtime: slice(ts.r_loadmanageblockingtime),
    r_dooropencount: slice(ts.r_dooropencount),
    did_dooropencount: slice(ts.did_dooropencount),
    f_loadmanage: slice(ts.f_loadmanage),
    f_defrost_signal: slice(ts.f_defrost_signal),
    f_dooropencount: slice(ts.f_dooropencount),
    r_dooropentime: slice(ts.r_dooropentime),
    did_dooropentime: slice(ts.did_dooropentime),
    f_dooropentime: slice(ts.f_dooropentime),
    operation_state: slice(ts.operation_state),
    compowerlevel: slice(ts.compowerlevel),
  };
}

function filterLabelsByRange(labels, startMs, endMs) {
  if (startMs == null && endMs == null) return labels;
  return labels.filter((row) => {
    const ws = _parseIsoToMs(row.window_start);
    const we = _parseIsoToMs(row.window_end);
    if (ws == null && we == null) return true;
    if (startMs != null && we != null && we < startMs) return false;
    if (endMs != null && ws != null && ws > endMs) return false;
    return true;
  });
}

async function onFileClick(rowEl) {
  const sourcePath = rowEl.dataset.sourcePath;
  if (!sourcePath) return;
  currentSourcePath = sourcePath;
  // 파일 선택 시 선택 표시만 하고, 실제 로딩은 버튼 클릭 시 수행
  const btnApply = document.getElementById("btn-apply-label");
  if (btnApply) btnApply.disabled = false;
  const rows = document.querySelectorAll("#file-tbody tr");
  rows.forEach((r) => r.classList.remove("file-selected"));
  rowEl.classList.add("file-selected");
}

function renderCharts(ts) {
  // Chart.js 한글 폰트 강제
  Chart.defaults.font.family = FONT_FAMILY;
  if (Chart.register) {
    // id 기반으로 중복 등록을 피하기 위해 try-catch
    try {
      Chart.register(crosshairPlugin);
      Chart.register(rangeHighlightPlugin);
    } catch (_) {
      // ignore
    }
  }

  const ctxTemp = document.getElementById("ts-chart").getContext("2d");
  const ctxAux = document.getElementById("aux-chart").getContext("2d");
  const labels = ts.time || [];
  const rSensor = ts.r_sensor || [];
  const rControl = ts.r_control || [];
  const fSensor = ts.f_sensor || [];
  const fControl = ts.f_control || [];
  const airTemp = ts.airtemperature || [];

  const rLoad = ts.r_loadmanage || [];
  const rBlock = ts.r_loadmanageblockingtime || [];
  const rDoor = ts.r_dooropencount || [];
  const didDoor = ts.did_dooropencount || [];
  const fLoad = ts.f_loadmanage || [];
  const fDefrost = ts.f_defrost_signal || [];
  const fDoor = ts.f_dooropencount || [];

  // 스케일 적용(읽기 쉽게)
  const scale = (arr, k) => arr.map((v) => (v == null ? null : Number(v) * k));
  const rLoadS = scale(rLoad, 10);
  const rBlockS = scale(rBlock, 0.05);
  const rDoorS = scale(rDoor, 2);
  const didDoorS = scale(didDoor, 2);
  // 냉동실 보조지표는 음수 스케일로 표시 (시각적으로 구분)
  const fLoadS = scale(fLoad, -10);
  const fDefrostS = scale(fDefrost, -5);
  const fDoorS = scale(fDoor, -2);

  lastAuxTooltipData = {
    indexToTime: labels,
    series: [
      { key: "r_load", label: "냉장 부하대응 여부", values: rLoad },
      { key: "r_block", label: "냉장 부하대응 차단시간[분]", values: rBlock },
      { key: "r_door", label: "냉장 문열림횟수(5분)[회]", values: rDoor },
      { key: "f_load", label: "냉동 부하대응 여부", values: fLoad },
      { key: "f_defrost", label: "냉동 제상신호", values: fDefrost },
      { key: "f_door", label: "냉동 문열림횟수(5분)[회]", values: fDoor },
    ],
    extra: [
      { key: "r_door_time", label: "냉장 문열림시간(5분)[초]",values: ts.r_dooropentime || [] },
      { key: "f_door_time", label: "냉동 문열림시간(5분)[초]", values: ts.f_dooropentime || [] },
      { key: "comp", label: "COMP 냉력 지령", values: ts.compowerlevel || [] },
    ],
  };

  currentTimesMs = labels.map(_parseIsoToMs);
  highlightRange = null;

  if (chartTemp) {
    chartTemp.destroy();
  }
  if (chartAux) {
    chartAux.destroy();
  }

  chartTemp = new Chart(ctxTemp, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "냉장실 센서온도[℃]",
          data: rSensor,
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14,165,233,0.1)",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉장실 제어온도[℃]",
          data: rControl,
          borderColor: "#f97316",
          backgroundColor: "rgba(249,115,22,0.08)",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉동실 센서온도[℃]",
          data: fSensor,
          borderColor: "#22c55e",
          backgroundColor: "rgba(34,197,94,0.08)",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉동실 제어온도[℃]",
          data: fControl,
          borderColor: "#a855f7",
          backgroundColor: "rgba(168,85,247,0.08)",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "주위온도[℃]",
          data: airTemp,
          borderColor: "#6b7280",
          borderDash: [4, 4],
          spanGaps: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      onHover: (event, _active, chart) => {
        const els = chart.getElementsAtEventForMode(
          event,
          "index",
          { intersect: false },
          false
        );
        if (!els || els.length === 0) return;
        syncHover(els[0].index);
      },
      plugins: {
        legend: {
          position: "top",
          labels: { font: { size: 11 } },
        },
        tooltip: {
          enabled: false,
          external: makeExternalTooltip("ts-chart-tooltip"),
        },
      },
      scales: {
        x: {
          ticks: { display: false },
          grid: { drawTicks: false },
        },
        y: {
          ticks: { font: { size: 10 } },
        },
      },
    },
  });

  chartAux = new Chart(ctxAux, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "냉장 부하대응 (×10)",
          data: rLoadS,
          borderColor: "#2563EB",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉장 부하대응 차단시간 (×0.05)",
          data: rBlockS,
          borderColor: "#9333EA",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉장 문열림횟수 (×2)",
          data: rDoorS,
          borderColor: "#16A34A",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉동 부하대응 (×-10)",
          data: fLoadS,
          borderColor: "#0D9488",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉동 제상신호 (×-5)",
          data: fDefrostS,
          borderColor: "#F59E0B",
          spanGaps: true,
          tension: 0.15,
        },
        {
          label: "냉동 문열림횟수 (×-2)",
          data: fDoorS,
          borderColor: "#DB2777",
          spanGaps: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      onHover: (event, _active, chart) => {
        const els = chart.getElementsAtEventForMode(
          event,
          "index",
          { intersect: false },
          false
        );
        if (!els || els.length === 0) return;
        syncHover(els[0].index);
      },
      plugins: {
        legend: {
          position: "top",
          labels: { font: { size: 11 } },
        },
        tooltip: {
          enabled: false,
          external: makeExternalTooltip("aux-chart-tooltip"),
        },
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 70,
            minRotation: 40,
            autoSkip: true,
            font: (ctx) => {
              const base = { size: 9 };
              if (ctx.index === currentActiveIndex) {
                return { ...base, weight: "bold" };
              }
              return { ...base, weight: "normal" };
            },
            color: (ctx) => (ctx.index === currentActiveIndex ? "#111827" : "#6b7280"),
          },
        },
        y: {
          ticks: { font: { size: 10 } },
        },
      },
    },
  });

  // 차트 영역에서 벗어나면 크로스헤어/하이라이트 해제
  const c1 = document.getElementById("ts-chart");
  const c2 = document.getElementById("aux-chart");
  const clearAll = () => {
    setActiveIndex(chartTemp, -1);
    setActiveIndex(chartAux, -1);
    highlightRange = null;
    currentActiveIndex = -1;
    if (chartTemp) chartTemp.update("none");
    if (chartAux) chartAux.update("none");
    clearLabelHighlight();
    ["ts-chart-tooltip", "aux-chart-tooltip"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove("visible");
        el.innerHTML = "";
        el.setAttribute("aria-hidden", "true");
      }
    });
    const ph = document.getElementById("ts-chart-tooltip-placeholder");
    if (ph) ph.style.display = "";
  };
  c1.addEventListener("mouseleave", clearAll);
  c2.addEventListener("mouseleave", clearAll);
}

function renderLabels(labels) {
  const container = document.getElementById("labels-container");
  if (!container) return;
  container.innerHTML = "";
  labelRanges = [];
  selectedLabelTr = null;

  const isV2 = labels.length > 0 && labels[0].cause_code_R != null;

  const theadRow = `
    <tr>
      <th>날짜</th>
      <th>시간대</th>
      <th>CAUSE</th>
      <th>Cause 예제</th>
      <th>EFFECT</th>
      <th>Effect 예제</th>
      <th>ACTION</th>
      <th>Action 예제</th>
      <th class="sentence-col">Sentence</th>
      <th>휴먼 일치</th>
    </tr>`;

  function causeBadgeHtml(causeCode) {
    const code = (causeCode || "").toString();
    const upper = code.toUpperCase();
    const classMap = {
      NORMAL: "badge-cause-normal",
      DOOR_OPEN_FREQUENT: "badge-cause-door-open-frequent",
      HIGH_LOAD_INPUT: "badge-cause-high-load-input",
      HIGH_LOAD_AGAINST: "badge-cause-high-load-against",
      DEFROST_CYCLE: "badge-cause-defrost-cycle",
      DEFROST_DOOR_OPEN: "badge-cause-defrost-door-open",
      HIGH_TEMP_SETTING: "badge-cause-high-temp-setting",
      LOW_TEMP_SETTING: "badge-cause-low-temp-setting",
      UNKNOWN_EFFECT: "badge-cause-unknown-effect",
    };
    const extraClass = classMap[upper] || classMap.UNKNOWN_EFFECT;
    const cls = `badge ${extraClass}`;
    return `<span class="${cls}">${code}</span>`;
  }

  function addRowHighlightHandlers(trs, startMs, endMs) {
    const highlightThisRange = () => {
      setHighlightRangeByMs(startMs, endMs);
      clearLabelHighlight();
      trs.forEach((t) => t.classList.add("row-highlight"));
    };
    const clearThisRange = () => {
      highlightRange = null;
      if (chartTemp) chartTemp.update("none");
      if (chartAux) chartAux.update("none");
      trs.forEach((t) => t.classList.remove("row-highlight"));
    };
    trs.forEach((tr) => {
      tr.addEventListener("mouseenter", () => {
        highlightThisRange();
        // 마우스 호버 시 sentence를 디스플레이에 표시
        previewSentenceFromRow(tr);
      });
      tr.addEventListener("mouseleave", clearThisRange);
    });
  }

  if (isV2) {
    const table = document.createElement("table");
    table.className = "labels-table-v2";
    table.innerHTML = `
      <thead>
        <tr>
          <th class="date-col">날짜</th>
          <th class="time-col">시간대</th>
          <th colspan="7">냉장실 (R)</th>
          <th colspan="7">냉동실 (F)</th>
          <th class="sentence-col">Sentence (R/F)</th>
        </tr>
        <tr>
          <th class="date-col"></th><th class="time-col"></th>
          <th class="cea-col">CAUSE</th><th class="cea-col">Cause<br/>예제</th><th class="cea-col">EFFECT</th><th class="cea-col">Effect<br/>예제</th><th class="cea-col">ACTION</th><th class="cea-col">Action<br/>예제</th><th class="human-match-col">휴먼 일치</th>
          <th class="cea-col">CAUSE</th><th class="cea-col">Cause<br/>예제</th><th class="cea-col">EFFECT</th><th class="cea-col">Effect<br/>예제</th><th class="cea-col">ACTION</th><th class="cea-col">Action<br/>예제</th><th class="human-match-col">휴먼 일치</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    container.appendChild(table);
    const tbody = table.querySelector("tbody");

    labels.forEach((row) => {
      const ws = row.window_start || "";
      const we = row.window_end || "";
      const dateStr = ws ? String(ws).slice(0, 10) : "";
      const time = ws && we ? `${String(ws).slice(11, 16)} ~ ${String(we).slice(11, 16)}` : "";
      const humanMatch = row.human_match !== undefined ? row.human_match : "-";
      const matchClass = humanMatch === "O" ? "human-o" : humanMatch === "X" ? "human-x" : "";

      const causeR = row.cause_code_R || "";
      const exR = row.cause_example_R || "";
      const effR = row.effect_R || "";
      const effExR = row.effect_example_R || "";
      const actR = row.action_R || "";
      const actExR = row.action_example_R || "";
      const sentR = formatSentenceByCauseCode(causeR, exR, effExR, actExR);

      const causeF = row.cause_code_F || "";
      const exF = row.cause_example_F || "";
      const effF = row.effect_F || "";
      const effExF = row.effect_example_F || "";
      const actF = row.action_F || "";
      const actExF = row.action_example_F || "";
      const sentF = formatSentenceByCauseCode(causeF, exF, effExF, actExF);

      let combinedSentence;
      if (causeR === "NORMAL" && causeF === "NORMAL") {
        combinedSentence = "현재 제품은 정상 동작 중이며,<br/>진단 결과 이상 없습니다.";
      } else {
        combinedSentence = `냉장실은 ${sentR || ""}<br/>냉동실은 ${sentF || ""}`;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="date-col">${dateStr}</td>
        <td class="time-col">${time}</td>
        <td class="cea-col">${causeBadgeHtml(causeR)}</td>
        <td class="cea-col">${exR}</td>
        <td class="cea-col">${effR}</td>
        <td class="cea-col">${effExR}</td>
        <td class="cea-col">${actR}</td>
        <td class="cea-col">${actExR}</td>
        <td class="human-match-col ${matchClass}">${humanMatch}</td>
        <td class="cea-col">${causeBadgeHtml(causeF)}</td>
        <td class="cea-col">${exF}</td>
        <td class="cea-col">${effF}</td>
        <td class="cea-col">${effExF}</td>
        <td class="cea-col">${actF}</td>
        <td class="cea-col">${actExF}</td>
        <td class="human-match-col ${matchClass}">${humanMatch}</td>
        <td class="sentence-col">${combinedSentence}</td>
      `;
      {
        const sentenceTd = tr.querySelector("td.sentence-col");
        const rendered = sentenceTd ? sentenceTd.innerText || sentenceTd.textContent : "";
        tr.dataset.sentenceText = _normalizeSentenceForDisplay(rendered || combinedSentence);
      }
      tr.addEventListener("click", () => setSelectedLabelRow(tr));
      tbody.appendChild(tr);

      const startMs = _parseIsoToMs(ws) ?? -Infinity;
      const endMs = _parseIsoToMs(we) ?? Infinity;
      labelRanges.push({ startMs, endMs, tr });
      addRowHighlightHandlers([tr], startMs, endMs);
    });
  } else {
    const table = document.createElement("table");
    table.innerHTML = "<thead>" + theadRow + "</thead><tbody id=\"label-tbody\"></tbody>";
    container.appendChild(table);
    const tbody = table.querySelector("tbody");
    labels.forEach((row) => {
      const ws = row.window_start || "";
      const we = row.window_end || "";
      const dateStr = ws ? String(ws).slice(0, 10) : ""; // YYYY-MM-DD
      const time = ws && we ? `${String(ws).slice(11, 16)} ~ ${String(we).slice(11, 16)}` : "";
      const cause = row.cause_code || "";
      const causeExample = row.cause_example || "";
      const effect = row.effect || "";
      const effectExample = row.effect_example || "";
      const action = row.action || "";
      const actionExample = row.action_example || "";
      const sentence =
        cause === "NORMAL"
          ? "현재 제품은 정상 동작 중이며,<br/>진단 결과 이상 없습니다."
          : formatSentence(causeExample, effectExample, actionExample);
      const humanMatch = row.human_match !== undefined ? row.human_match : "-";
      const matchClass = humanMatch === "O" ? "human-o" : humanMatch === "X" ? "human-x" : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${dateStr}</td>
        <td>${time}</td>
        <td>${causeBadgeHtml(cause)}</td>
        <td>${causeExample}</td>
        <td>${effect}</td>
        <td>${effectExample}</td>
        <td>${action}</td>
        <td>${actionExample}</td>
        <td class="sentence-col">${sentence}</td>
        <td class="${matchClass}">${humanMatch}</td>
      `;
      {
        const sentenceTd = tr.querySelector("td.sentence-col");
        const rendered = sentenceTd ? sentenceTd.innerText || sentenceTd.textContent : "";
        tr.dataset.sentenceText = _normalizeSentenceForDisplay(rendered || sentence);
      }
      tr.addEventListener("click", () => setSelectedLabelRow(tr));
      tbody.appendChild(tr);

      const startMs = _parseIsoToMs(ws) ?? -Infinity;
      const endMs = _parseIsoToMs(we) ?? Infinity;
      labelRanges.push({ startMs, endMs, tr });
      addRowHighlightHandlers([tr], startMs, endMs);
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-apply-label").addEventListener("click", async () => {
    if (!currentSourcePath) return;
    try {
      await loadFileDetail(currentSourcePath);
    } catch (e) {
      console.error(e);
      document.getElementById("status").textContent = "시계열/라벨 로드 실패";
    }
  });
  const startRange = document.getElementById("ts-range-start");
  const endRange = document.getElementById("ts-range-end");
  if (startRange) startRange.addEventListener("change", applyTimeRangeAndRender);
  if (endRange) endRange.addEventListener("change", applyTimeRangeAndRender);
  const btnDisplay = document.getElementById("btn-display");
  if (btnDisplay) {
    btnDisplay.addEventListener("click", () => {
      const sentence = getSentenceForDisplay();
      const features = "width=887,height=333,resizable=yes,scrollbars=no";
      const w = window.open("display.html", "displayWindow", features);
      if (w && typeof w.postMessage === "function") {
        displayWindowRefs.push(w);
        _persistAndBroadcastSentence(sentence);
        try {
          w.focus();
        } catch (_) {
          // ignore
        }
      } else {
        // 팝업 차단 등 실패 시: 화면 내 오버레이로 대체
        _persistAndBroadcastSentence(sentence);
        showDisplayOverlay(sentence);
      }
    });
  }

  const btnDisplay24 = document.getElementById("btn-display-24");
  if (btnDisplay24) {
    btnDisplay24.addEventListener("click", () => {
      const sentence = getSentenceForDisplay();
      const features = "width=360,height=240,resizable=yes,scrollbars=no";
      const w = window.open("display-24.html", "displayWindow24", features);
      if (w && typeof w.postMessage === "function") {
        displayWindowRefs.push(w);
        _persistAndBroadcastSentence(sentence);
        try {
          w.focus();
        } catch (_) {
          // ignore
        }
      } else {
        _persistAndBroadcastSentence(sentence);
        showDisplayOverlay(sentence);
      }
    });
  }

  const btnDisplayClose = document.getElementById("btn-display-close");
  if (btnDisplayClose) btnDisplayClose.addEventListener("click", hideDisplayOverlay);
  const overlay = document.getElementById("display-overlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideDisplayOverlay();
    });
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDisplayOverlay();
  });

  const btnSendDiag = document.getElementById("btn-send-diagnostic");
  if (btnSendDiag) {
    btnSendDiag.addEventListener("click", () => {
      sendDiagnosticToAgent();
    });
  }

  fetchFiles();
});

