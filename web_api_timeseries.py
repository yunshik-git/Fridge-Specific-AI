# -*- coding: utf-8 -*-
"""
웹 GUI용 Python API 스크립트.

Usage:
    python web_api_timeseries.py <source_path>

STDOUT로 JSON을 출력합니다:
{
  "timeseries": {
    "time": [...],            # ISO8601 문자열
    "r_sensor": [...],
    "r_control": [...],
    "f_sensor": [...],
    "f_control": [...]
  },
  "labels": [
    {
      "window_start": "...",
      "window_end": "...",
      "cause_code": "...",
      "cause_example": "...",
      "effect": "...",
      "effect_example": "...",
      "action": "...",
      "action_example": "..."
    },
    ...
  ]
}
"""
from __future__ import annotations

import json
import math
import pickle
import sys
from pathlib import Path

import pandas as pd

from label_mapping import (
    add_cause_effect_action_rf,
    get_effect_action,
    cause_example_ko,
    get_cause_code,
)

BASE_DIR = Path(__file__).resolve().parent
HUMAN_LABELS_FIXED = BASE_DIR / "human_labels_1h_fixed.csv"
FEATURES_PARQUET = BASE_DIR / "features_1h.parquet"
V2_ARTIFACTS = BASE_DIR / "v2" / "artifacts"

TIME_COL = "create_dt"
R_SENSOR = "r-sensortemperature"
R_CONTROL = "r-controltemperature"
F_SENSOR = "f-sensortemperature"
F_CONTROL = "f-controltemperature"
AIR_TEMP = "airtemperature"
R_LOAD = "r-loadmanage"
R_BLOCK = "r-loadmanageblockingtime"
R_DOOR = "r-dooropencount"
R_DOOR_TIME = "r-dooropentime"
DID_DOOR = "did-dooropencount"
DID_DOOR_TIME = "did-dooropentime"
F_LOAD = "f-loadmanage"
F_DEFROST = "f_defrost_signal"
F_DOOR = "f-dooropencount"
F_DOOR_TIME = "f-dooropentime"
OPERATION_MODE = "operationmode"
COMPRESSOR_POWER_LEVEL = "compressorpowerlevel"


def resolve_parquet_file(source_path: str) -> Path | None:
  """압축 배포본은 프로젝트 폴더만 사용. 경로 표기만 다를 때(절대/상대/파일명) parquet을 찾습니다."""
  raw = Path(str(source_path).strip())
  name = raw.name

  candidates: list[Path] = [
    raw,
    BASE_DIR / raw,
    BASE_DIR / "sample_data" / "parquet" / name,
    BASE_DIR / name,
  ]
  for cand in candidates:
    try:
      if cand.is_file():
        return cand
    except OSError:
      continue
  return None


def _match_source_series(series: pd.Series, source_path: str) -> pd.Series:
  """source_path가 절대경로·슬래시 형태 등으로 달라도 features/CSV와 매칭."""
  sp = str(source_path).strip()
  s = series.astype(str)
  exact = s == sp
  if exact.any():
    return exact
  want = Path(sp).name
  return s.map(lambda x: Path(str(x)).name) == want


def load_timeseries(source_path: str) -> dict:
  """원본 parquet에서 기본 시계열 데이터만 추출."""
  p = resolve_parquet_file(source_path)
  if p is None:
    return {"time": [], "r_sensor": [], "r_control": [], "f_sensor": [], "f_control": []}

  df = pd.read_parquet(p)
  if TIME_COL not in df.columns:
    # 시간 컬럼이 없으면 인덱스를 사용
    df[TIME_COL] = pd.RangeIndex(len(df))
  ts = pd.to_datetime(df[TIME_COL], errors="coerce")
  df[TIME_COL] = ts
  df = df.dropna(subset=[TIME_COL]).sort_values(TIME_COL).reset_index(drop=True)

  def _col(name: str):
    if name not in df.columns:
      return [None] * len(df)
    s = df[name]
    out = []
    for v in s.tolist():
      if pd.isna(v):
        out.append(None)
      else:
        # numpy scalar -> python scalar (NaN/Inf는 JSON 호환을 위해 null)
        try:
          if isinstance(v, (int, float)) or hasattr(v, "__float__"):
            fv = float(v)
            if not math.isfinite(fv):
              out.append(None)
            else:
              out.append(fv)
          else:
            out.append(v)
        except Exception:
          out.append(v)
    return out

  return {
    "time": df[TIME_COL].dt.strftime("%Y-%m-%dT%H:%M:%S").tolist(),
    "r_sensor": _col(R_SENSOR),
    "r_control": _col(R_CONTROL),
    "f_sensor": _col(F_SENSOR),
    "f_control": _col(F_CONTROL),
    "airtemperature": _col(AIR_TEMP),
    # auxiliary
    "r_loadmanage": _col(R_LOAD),
    "r_loadmanageblockingtime": _col(R_BLOCK),
    "r_dooropencount": _col(R_DOOR),
    "did_dooropencount": _col(DID_DOOR),
    "f_loadmanage": _col(F_LOAD),
    "f_defrost_signal": _col(F_DEFROST),
    "f_dooropencount": _col(F_DOOR),
    "r_dooropentime": _col(R_DOOR_TIME),
    "did_dooropentime": _col(DID_DOOR_TIME),
    "f_dooropentime": _col(F_DOOR_TIME),
    "operation_state": _col(OPERATION_MODE),
    "compowerlevel": _col(COMPRESSOR_POWER_LEVEL),
  }


def get_human_cause_by_window(source_path: str) -> dict:
  """해당 source_path의 휴먼 라벨을 (window_start, window_end) 키로 조회.
  값: {"cause_code": 대표코드, "cause_code_R": R코드, "cause_code_F": F코드}.
  """
  out = {}
  if not HUMAN_LABELS_FIXED.exists():
    return out
  try:
    df = pd.read_csv(HUMAN_LABELS_FIXED, encoding="utf-8-sig")
  except Exception:
    return out
  if "Unnamed: 0" in df.columns:
    df = df.drop(columns=["Unnamed: 0"])
  sub = df[_match_source_series(df["source_path"], source_path)].copy()
  if sub.empty:
    return out
  sub = add_cause_effect_action_rf(sub)
  sub["window_start"] = pd.to_datetime(sub["window_start"])
  sub["window_end"] = pd.to_datetime(sub["window_end"])
  for _, r in sub.iterrows():
    ws = r["window_start"].isoformat()
    we = r["window_end"].isoformat()
    key = (ws, we)
    out[key] = {
      "cause_code": get_cause_code(
        r.get("human_cause_label_R"), r.get("human_cause_label_F")
      ),
      "cause_code_R": str(r.get("cause_code_R", "") or "NORMAL"),
      "cause_code_F": str(r.get("cause_code_F", "") or "NORMAL"),
    }
  return out


def load_features_for_source(source_path: str) -> pd.DataFrame:
  """features_1h.parquet에서 해당 source_path 행만 추출 (window_start/end 정렬)."""
  if not FEATURES_PARQUET.exists():
    return pd.DataFrame()
  df = pd.read_parquet(FEATURES_PARQUET)
  if "source_path" not in df.columns:
    return pd.DataFrame()
  sub = df[_match_source_series(df["source_path"], source_path)].copy()
  if sub.empty:
    return sub
  sub["window_start"] = pd.to_datetime(sub["window_start"])
  sub["window_end"] = pd.to_datetime(sub["window_end"])
  sub = sub.sort_values("window_start").reset_index(drop=True)
  return sub


def labels_from_v2(source_path: str) -> list[dict]:
  """v2 R/F 모델로 예측한 라벨 목록 반환 (cause_code_R/F 등 포함)."""
  features = load_features_for_source(source_path)
  if features.empty:
    return []
  paths = [
    V2_ARTIFACTS / "cause_model_R.pkl", V2_ARTIFACTS / "cause_encoder_R.pkl",
    V2_ARTIFACTS / "cause_model_F.pkl", V2_ARTIFACTS / "cause_encoder_F.pkl",
    V2_ARTIFACTS / "feature_names.pkl",
  ]
  for p in paths:
    if not p.exists():
      return []
  with open(V2_ARTIFACTS / "cause_model_R.pkl", "rb") as f:
    clf_r = pickle.load(f)
  with open(V2_ARTIFACTS / "cause_encoder_R.pkl", "rb") as f:
    le_r = pickle.load(f)
  with open(V2_ARTIFACTS / "cause_model_F.pkl", "rb") as f:
    clf_f = pickle.load(f)
  with open(V2_ARTIFACTS / "cause_encoder_F.pkl", "rb") as f:
    le_f = pickle.load(f)
  with open(V2_ARTIFACTS / "feature_names.pkl", "rb") as f:
    feature_names = pickle.load(f)
  features = features.copy()
  for c in feature_names:
    if c not in features.columns:
      features[c] = 0
  X = features[feature_names].fillna(0)
  cause_r = le_r.inverse_transform(clf_r.predict(X))
  cause_f = le_f.inverse_transform(clf_f.predict(X))
  human_by_window = get_human_cause_by_window(source_path)
  out = []
  for i in range(len(features)):
    row = features.iloc[i]
    ws = pd.to_datetime(row["window_start"]).isoformat()
    we = pd.to_datetime(row["window_end"]).isoformat()
    human = human_by_window.get((ws, we))
    if human is None:
      human_match = "-"
    else:
      match_r = str(cause_r[i]) == str(human["cause_code_R"])
      match_f = str(cause_f[i]) == str(human["cause_code_F"])
      human_match = "O" if (match_r and match_f) else "X"
    ea_r = get_effect_action(cause_r[i])
    ea_f = get_effect_action(cause_f[i])
    out.append({
      "window_start": ws,
      "window_end": we,
      "cause_code": f"R:{cause_r[i]} / F:{cause_f[i]}",
      "cause_example": f"R: {cause_example_ko(cause_r[i])} | F: {cause_example_ko(cause_f[i])}",
      "effect": ea_r["effect"],
      "effect_example": ea_r["effect_example"],
      "action": ea_r["action"],
      "action_example": ea_r["action_example"],
      "cause_code_R": str(cause_r[i]),
      "cause_example_R": cause_example_ko(cause_r[i]),
      "effect_R": ea_r["effect"],
      "effect_example_R": ea_r["effect_example"],
      "action_R": ea_r["action"],
      "action_example_R": ea_r["action_example"],
      "cause_code_F": str(cause_f[i]),
      "cause_example_F": cause_example_ko(cause_f[i]),
      "effect_F": ea_f["effect"],
      "effect_example_F": ea_f["effect_example"],
      "action_F": ea_f["action"],
      "action_example_F": ea_f["action_example"],
      "human_match": human_match,
    })
  return out


def main(argv: list[str]) -> None:
  if len(argv) < 2:
    print(json.dumps({"error": "missing_source_path"}, ensure_ascii=False))
    sys.exit(1)
  source_path = str(argv[1]).strip()
  ts = load_timeseries(source_path)
  labels = labels_from_v2(source_path)
  print(json.dumps({"timeseries": ts, "labels": labels}, ensure_ascii=False))


if __name__ == "__main__":
  main(sys.argv)
