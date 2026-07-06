"""Gemini (Vertex AI / AI Studio) integration for VitalLens.

- analyze_meal_image: multimodal — photo + portion note -> structured nutrition JSON
- weekly_insight: score data -> plain-language coaching narrative
- chat: conversational answers grounded ONLY in the user's own logs + score
"""
import json
import os

from google import genai
from google.genai import types

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MISSING_GEMINI_CONFIG = (
    "Gemini is not configured. Set GEMINI_API_KEY on Cloud Run, or set "
    "GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT."
)
TEMPORARY_GEMINI_UNAVAILABLE = (
    "Gemini is temporarily unavailable due to high demand. Please try again in a few minutes."
)

_client = None

def _use_vertex_ai() -> bool:
    return os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() == "true"


def is_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY")) or (
        _use_vertex_ai() and bool(os.environ.get("GOOGLE_CLOUD_PROJECT"))
    )


def user_facing_error(exc: Exception) -> str:
    text = str(exc)
    if "503" in text and ("UNAVAILABLE" in text or "high demand" in text):
        return TEMPORARY_GEMINI_UNAVAILABLE
    return f"Gemini request failed: {text}"


def client() -> genai.Client:
    global _client
    if _client is None:
        if os.environ.get("GEMINI_API_KEY"):
            _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        elif _use_vertex_ai():
            if not os.environ.get("GOOGLE_CLOUD_PROJECT"):
                raise RuntimeError(MISSING_GEMINI_CONFIG)
            _client = genai.Client(
                vertexai=True,
                project=os.environ["GOOGLE_CLOUD_PROJECT"],
                location=os.environ.get("GOOGLE_CLOUD_LOCATION", "asia-south1"),
            )
        else:
            raise RuntimeError(MISSING_GEMINI_CONFIG)
    return _client


MEAL_PROMPT = """You are a clinical nutrition analyst for an Indian health platform.
Analyze this meal photo. The user says about portions: "{portion_note}".

Identify every distinct food item. Estimate realistic portion sizes (use the user's
note as ground truth where given; otherwise infer from visual cues like plate size).
Prefer Indian food names where applicable (e.g., roti, dal tadka, jeera rice).

Respond with ONLY valid JSON, no markdown, matching exactly this schema:
{{
  "items": [
    {{"name": str, "portion": str, "calories": number, "protein_g": number,
      "carbs_g": number, "fat_g": number, "sugar_g": number, "fiber_g": number,
      "sodium_mg": number, "salt_g": number}}
  ],
  "meal_guess": str,          // e.g. "lunch"
  "confidence": number,       // 0-1 overall
  "health_notes": [str]       // max 3, short, specific to THIS meal
}}"""

MEAL_TEXT_PROMPT = """You are a clinical nutrition analyst for an Indian health platform.
Analyze this typed meal description as the source of truth:
"{portion_note}"

Break it into distinct food items and realistic serving sizes. Prefer Indian food
names where applicable (e.g., roti, dal tadka, jeera rice). If quantity is vague,
estimate a normal serving and mention the uncertainty through portion wording.

Respond with ONLY valid JSON, no markdown, matching exactly this schema:
{{
  "items": [
    {{"name": str, "portion": str, "calories": number, "protein_g": number,
      "carbs_g": number, "fat_g": number, "sugar_g": number, "fiber_g": number,
      "sodium_mg": number, "salt_g": number}}
  ],
  "meal_guess": str,          // e.g. "lunch"
  "confidence": number,       // 0-1 overall
  "health_notes": [str]       // max 3, short, specific to THIS meal
}}"""


def _finalize_meal_analysis(data: dict) -> dict:
    items = data.get("items", [])
    for item in items:
        if not item.get("salt_g") and item.get("sodium_mg"):
            item["salt_g"] = round(float(item.get("sodium_mg") or 0) * 2.5 / 1000, 2)
    data["totals"] = {
        k: round(sum(float(i.get(k) or 0) for i in items), 1)
        for k in ("calories", "protein_g", "carbs_g", "fat_g", "sugar_g", "fiber_g", "sodium_mg", "salt_g")
    }
    data["totals"]["sodium_mg"] = round(data["totals"]["sodium_mg"])
    data["totals"]["salt_g"] = round(data["totals"]["salt_g"], 2)
    return data


def analyze_meal_image(image_bytes: bytes, mime_type: str, portion_note: str) -> dict:
    resp = client().models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            MEAL_PROMPT.format(portion_note=portion_note or "not specified"),
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json", temperature=0.2
        ),
    )
    return _finalize_meal_analysis(json.loads(resp.text))


def analyze_meal_text(portion_note: str) -> dict:
    resp = client().models.generate_content(
        model=MODEL,
        contents=MEAL_TEXT_PROMPT.format(portion_note=portion_note),
        config=types.GenerateContentConfig(
            response_mime_type="application/json", temperature=0.2
        ),
    )
    return _finalize_meal_analysis(json.loads(resp.text))


def weekly_insight(score_data: dict) -> str:
    prompt = f"""You are a warm, evidence-based lifestyle coach on an Indian health platform.
Here is the user's last-7-day data and transparent score breakdown (rule-based, WHO-aligned):
{json.dumps(score_data, indent=2)}

Write a short coaching insight: 3-4 sentences max. Reference their actual numbers.
One specific, achievable action for the coming week. No greetings, no disclaimers,
no medical diagnosis — signals only. Plain language."""
    resp = client().models.generate_content(
        model=MODEL, contents=prompt,
        config=types.GenerateContentConfig(temperature=0.6),
    )
    return resp.text.strip()


def chat(message: str, score_data: dict, meals: list, activities: list, history: list[dict]) -> str:
    context = {
        "score": score_data,
        "recent_meals": [
            {k: m.get(k) for k in ("date", "meal_guess", "items_summary", "portion_note", "calories", "protein_g", "carbs_g", "fat_g", "sugar_g", "fiber_g", "sodium_mg", "salt_g")}
            for m in meals[-15:]
        ],
        "recent_activities": [
            {k: a.get(k) for k in ("date", "type", "minutes", "intensity", "source")}
            for a in activities[-15:]
        ],
    }
    system = f"""You are VitalLens Coach, a decision-support assistant on an Indian community
health platform. Answer the user's question grounded ONLY in their real logged data below
and general nutrition/exercise science. Their data:
{json.dumps(context, default=str)}

Rules: be specific with their numbers; keep answers under 120 words; give actionable
guidance; you provide lifestyle signals, not medical diagnoses — say so ONLY if the user
asks about disease risk; if data is insufficient, say what to log."""
    contents = []
    for turn in history[-6:]:
        contents.append(types.Content(role=turn["role"], parts=[types.Part.from_text(text=turn["text"])]))
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))
    resp = client().models.generate_content(
        model=MODEL, contents=contents,
        config=types.GenerateContentConfig(system_instruction=system, temperature=0.5),
    )
    return resp.text.strip()
