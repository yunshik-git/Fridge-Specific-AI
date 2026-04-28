# -*- coding: utf-8 -*-
"""
CAUSE -> EFFECT -> ACTION 매핑 (이미지 참조 형식).
한글 인간 라벨을 표준 CAUSE 코드로 매핑하고, EFFECT/ACTION 및 예제 문구를 제공합니다.
"""
from __future__ import annotations

import pandas as pd

# 한글 원인 라벨 -> 표준 CAUSE 코드(이미지의 CAUSE 컬럼) 매핑
# NOTE: 현재 라벨셋(1h_fixed)에 존재하는 항목 중심으로 매핑합니다.
LABEL_TO_CAUSE = {
    "정상": "NORMAL",
    "냉장실 부하대응": "HIGH_LOAD_INPUT",
    "냉장실 부하대응 제한": "HIGH_LOAD_AGAINST",
    "냉장실 제어온도 높음": "HIGH_TEMP_SETTING",
    "제상 중 문열림 (냉장실)": "DEFROST_DOOR_OPEN",
    "제상 중 문열림 (냉동실)": "DEFROST_DOOR_OPEN",
    "냉장실 제상 영향": "DEFROST_CYCLE",
    "냉동실 제상 영향": "DEFROST_CYCLE",
    "냉장실 문열림 영향": "DOOR_OPEN_FREQUENT",
    "냉동실 문열림 영향": "DOOR_OPEN_FREQUENT",
    # "냉동실 온도 상승"은 '원인'이라기보다 상태/현상에 가까워 UNKNOWN_EFFECT로 둡니다.
    "냉동실 온도 상승": "UNKNOWN_EFFECT",
    "설명 불가능": "UNKNOWN_EFFECT",
}

# CAUSE -> (EFFECT 코드, EFFECT 예제, ACTION 코드, ACTION 예제)
# 이미지의 3개 표(CAUSE / EFFECT / ACTION)를 그대로 쓰도록 정리합니다.
CAUSE_EFFECT_ACTION = {
    "NORMAL": (
        "NORMAL",
        "정상 동작 상태입니다",
        "DIAG_NORMAL",
        "진단 결과 이상 없이 정상입니다",
    ),
    "DOOR_OPEN_FREQUENT": (
        "TEMP_RISE",
        "내부 온도가 일시적으로 상승했습니다",
        "COMPRESSOR_HIGH",
        "냉각을 강화하고 있습니다",
    ),
    "HIGH_LOAD_INPUT": (
        "TEMP_COOLING_DOWN",
        "내부 온도가 일시적으로 상승했습니다",
        "COMPRESSOR_HIGH",
        "냉각을 강화하고 있습니다",
    ),
    "HIGH_LOAD_AGAINST": (
        "TEMP_IN_RANGE",
        "내부 온도가 일시적으로 상승했습니다",
        "DIAG_NORMAL",
        "각을 강화하고 있습니다",
    ),
    "DEFROST_CYCLE": (
        "TEMP_RISE",
        "내부 온도가 일시적으로 상승했습니다",
        "DEFROST",
        "시간이 흐르면 정상 온도로 복귀 합니다.",
    ),
    "DEFROST_DOOR_OPEN": (
        "TEMP_RISE",
        "내부 온도가 일시적으로 상승했습니다",
        "DEFROST",
        "시간이 흐르면 정상 온도로 복귀 합니다.",
    ),
    "HIGH_TEMP_SETTING": (
        "TEMP_IN_RANGE",
        "설정값 대비 온도가 정상 범위입니다",
        "DIAG_NORMAL",
        "진단 결과 이상 없이 정상입니다. 필요시 설정온도를 낮추세요",
    ),
    "LOW_TEMP_SETTING": (
        "TEMP_IN_RANGE",
        "설정값 대비 온도가 정상 범위입니다",
        "DIAG_NORMAL",
        "진단 결과 이상 없이 정상입니다",
    ),
    "UNKNOWN_EFFECT": (
        "NORMAL",
        "원인을 판단하는데 어려움이 있습니다",
        "DIAG_NORMAL",
        "반복시 서비스 센터를 연결하세요",
    ),
}

# CAUSE 코드 -> 한글 원인 예제 (이미지의 "Cause 예제" 문구 톤)
CAUSE_EXAMPLE_KO = {
    "NORMAL": "정상 동작 중",
    "DOOR_OPEN_FREQUENT": "최근 문을 자주 열어",
    "HIGH_LOAD_INPUT": "뜨거운 물건이 들어와서",
    "HIGH_LOAD_AGAINST": "과냉 방지 로직 동작 중",
    "DEFROST_CYCLE": "제상 운전이 진행되어",
    "DEFROST_DOOR_OPEN": "제상 중에 도어 개폐가 발생하여",
    "HIGH_TEMP_SETTING": "설정 온도가 높게 설정되어",
    "LOW_TEMP_SETTING": "설정 온도가 낮게 설정되어",
    "UNKNOWN_EFFECT": "알 수 없는 이유로",
}


def get_cause_code(label_r: str, label_f: str):
    """냉장실(R)/냉동실(F) 한글 라벨에서 대표 CAUSE 코드 1개 반환. 비정상이 있으면 우선."""
    non_normal = []
    if pd.isna(label_r) or label_r == "정상":
        pass
    else:
        non_normal.append(LABEL_TO_CAUSE.get(label_r, "UNKNOWN_EFFECT"))
    if pd.isna(label_f) or label_f == "정상":
        pass
    else:
        non_normal.append(LABEL_TO_CAUSE.get(label_f, "UNKNOWN_EFFECT"))
    if not non_normal:
        return "NORMAL"
    return non_normal[0]


def get_effect_action(cause_code: str):
    """CAUSE 코드 -> (EFFECT, Effect예제, ACTION, Action예제) 반환."""
    t = CAUSE_EFFECT_ACTION.get(cause_code, CAUSE_EFFECT_ACTION["UNKNOWN_EFFECT"])
    return {
        "effect": t[0],
        "effect_example": t[1],
        "action": t[2],
        "action_example": t[3],
    }


def cause_example_ko(cause_code: str) -> str:
    return CAUSE_EXAMPLE_KO.get(cause_code, "알 수 없음")


def label_to_cause_code(label: str) -> str:
    """한글 라벨 문자열 -> 표준 CAUSE 코드.

    - 비어있거나 NaN이면 NORMAL
    - 매핑에 없으면 UNKNOWN_EFFECT
    """
    if label is None or pd.isna(label):
        return "NORMAL"
    s = str(label).strip()
    if not s or s == "정상":
        return "NORMAL"
    return LABEL_TO_CAUSE.get(s, "UNKNOWN_EFFECT")


def add_cause_effect_action_rf(df: pd.DataFrame) -> pd.DataFrame:
    """DataFrame에 human_cause_label_R/F가 있다고 가정하고
    R/F 각각에 대해 cause/effect/action 컬럼을 추가한다.

    추가 컬럼:
    - cause_code_R/F, cause_example_R/F
    - effect_R/F, effect_example_R/F
    - action_R/F, action_example_R/F
    """
    out = df.copy()
    r = out.get("human_cause_label_R")
    f = out.get("human_cause_label_F")
    if r is None:
        r = pd.Series(["정상"] * len(out), index=out.index)
    if f is None:
        f = pd.Series(["정상"] * len(out), index=out.index)
    r = r.fillna("정상")
    f = f.fillna("정상")

    cause_r = [label_to_cause_code(x) for x in r]
    cause_f = [label_to_cause_code(x) for x in f]
    out["cause_code_R"] = cause_r
    out["cause_code_F"] = cause_f
    out["cause_example_R"] = [cause_example_ko(c) for c in cause_r]
    out["cause_example_F"] = [cause_example_ko(c) for c in cause_f]

    ea_r = [get_effect_action(c) for c in cause_r]
    ea_f = [get_effect_action(c) for c in cause_f]
    out["effect_R"] = [o["effect"] for o in ea_r]
    out["effect_F"] = [o["effect"] for o in ea_f]
    out["effect_example_R"] = [o["effect_example"] for o in ea_r]
    out["effect_example_F"] = [o["effect_example"] for o in ea_f]
    out["action_R"] = [o["action"] for o in ea_r]
    out["action_F"] = [o["action"] for o in ea_f]
    out["action_example_R"] = [o["action_example"] for o in ea_r]
    out["action_example_F"] = [o["action_example"] for o in ea_f]
    return out


def add_cause_effect_action(df: pd.DataFrame):
    """DataFrame에 human_cause_label_R, human_cause_label_F가 있다고 가정하고
    cause_code, cause_example, effect, effect_example, action, action_example 컬럼 추가."""
    r, f = df["human_cause_label_R"].fillna("정상"), df["human_cause_label_F"].fillna("정상")
    cause_codes = [get_cause_code(ri, fi) for ri, fi in zip(r, f)]
    df = df.copy()
    df["cause_code"] = cause_codes
    df["cause_example"] = [cause_example_ko(c) for c in cause_codes]
    out = [get_effect_action(c) for c in cause_codes]
    df["effect"] = [o["effect"] for o in out]
    df["effect_example"] = [o["effect_example"] for o in out]
    df["action"] = [o["action"] for o in out]
    df["action_example"] = [o["action_example"] for o in out]
    return df
