"""VitalScore: transparent, explainable lifestyle risk scoring.

Rule-based core (WHO / ICMR-aligned heuristics) so every point is auditable;
Gemini adds the narrative layer, never the arithmetic. 0-100, higher = healthier.
"""
from datetime import datetime, timedelta, timezone

TARGETS = {
    "calories_per_day": 2000,
    "sugar_g_per_day": 50,       # WHO free-sugar guidance (~10% energy)
    "sodium_mg_per_day": 2000,   # WHO sodium limit
    "protein_g_per_day": 55,
    "activity_min_per_week": 150,  # WHO moderate-activity guidance
}

BANDS = [(80, "Thriving"), (60, "On Track"), (40, "Caution"), (0, "At Risk")]


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def compute_score(meals: list[dict], activities: list[dict], targets: dict | None = None) -> dict:
    t = {**TARGETS, **(targets or {})}
    now = datetime.now(timezone.utc)
    week_ago = (now - timedelta(days=7)).date().isoformat()

    meals = [m for m in meals if str(m.get("date", ""))[:10] >= week_ago]
    activities = [a for a in activities if str(a.get("date", ""))[:10] >= week_ago]

    days_logged = len({str(m.get("date", ""))[:10] for m in meals})
    days = max(days_logged, 1)

    tot = lambda key: sum(float(m.get(key) or 0) for m in meals)  # noqa: E731
    avg_cal = tot("calories") / days
    avg_sugar = tot("sugar_g") / days
    avg_sodium = tot("sodium_mg") / days
    avg_protein = tot("protein_g") / days

    active_min = sum(float(a.get("minutes") or 0) *
                     (1.5 if a.get("intensity") == "high" else 1.0)
                     for a in activities)

    # --- component scores (0-1) ---
    # Calories: full marks within +/-15% of target, linear falloff
    dev = abs(avg_cal - t["calories_per_day"]) / t["calories_per_day"] if avg_cal else 1.0
    cal_s = _clamp(1.0 - max(0.0, dev - 0.15) / 0.35) if avg_cal else 0.3
    sugar_s = _clamp(1.0 - max(0.0, avg_sugar - t["sugar_g_per_day"]) / t["sugar_g_per_day"])
    sodium_s = _clamp(1.0 - max(0.0, avg_sodium - t["sodium_mg_per_day"]) / t["sodium_mg_per_day"])
    protein_s = _clamp(avg_protein / t["protein_g_per_day"])
    act_s = _clamp(active_min / t["activity_min_per_week"])
    consistency_s = _clamp(days_logged / 7)

    weights = {"activity": 0.30, "calories": 0.20, "sugar": 0.15,
               "sodium": 0.15, "protein": 0.10, "consistency": 0.10}
    comp = {"activity": act_s, "calories": cal_s, "sugar": sugar_s,
            "sodium": sodium_s, "protein": protein_s, "consistency": consistency_s}
    score = round(sum(weights[k] * comp[k] for k in weights) * 100)
    band = next(label for cut, label in BANDS if score >= cut)

    # --- explainable risk signals ---
    signals = []
    if avg_sugar > t["sugar_g_per_day"] * 1.3 and act_s < 0.5:
        signals.append({
            "type": "type2_diabetes",
            "level": "elevated",
            "why": f"Avg sugar {avg_sugar:.0f}g/day (target ≤{t['sugar_g_per_day']}g) with only {active_min:.0f} active min this week.",
        })
    elif avg_sugar > t["sugar_g_per_day"]:
        signals.append({"type": "type2_diabetes", "level": "watch",
                        "why": f"Sugar intake trending {avg_sugar / t['sugar_g_per_day'] * 100 - 100:.0f}% above WHO guidance."})
    if avg_sodium > t["sodium_mg_per_day"] * 1.25:
        level = "elevated" if act_s < 0.6 else "watch"
        signals.append({"type": "hypertension", "level": level,
                        "why": f"Avg sodium {avg_sodium:.0f}mg/day vs {t['sodium_mg_per_day']}mg WHO limit."})
    if act_s < 0.35:
        signals.append({"type": "sedentary_lifestyle", "level": "elevated",
                        "why": f"{active_min:.0f} of {t['activity_min_per_week']} recommended weekly active minutes."})
    if not signals:
        signals.append({"type": "none", "level": "healthy",
                        "why": "No elevated risk patterns detected in the last 7 days. Keep it up!"})

    return {
        "score": score,
        "band": band,
        "components": {k: round(v * 100) for k, v in comp.items()},
        "weights": weights,
        "weekly": {
            "avg_calories": round(avg_cal),
            "avg_sugar_g": round(avg_sugar, 1),
            "avg_sodium_mg": round(avg_sodium),
            "avg_protein_g": round(avg_protein, 1),
            "active_minutes": round(active_min),
            "days_logged": days_logged,
            "meals_logged": len(meals),
        },
        "signals": signals,
        "targets": t,
    }
