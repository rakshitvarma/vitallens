# VitalLens — AI Decision Intelligence for Everyday Health

**Gen AI Academy Hackathon (APAC) · Track: Healthcare access & community wellness**

Snap a photo of your meal → Gemini identifies every dish, estimates portions and returns full nutrition. Combined with your activity data (Strava sync / manual log), VitalLens computes a transparent, WHO-aligned **VitalScore (0–100)** with explainable risk signals for type-2 diabetes, hypertension and sedentary lifestyle — plus a conversational coach grounded in *your own* logged data, and an anonymized community dashboard for public-health stakeholders.

## Architecture

```
Browser SPA ──► Cloud Run (FastAPI container)
                 ├─► Gemini 2.5 Flash (Vertex AI / AI Studio)
                 │     · multimodal meal-photo analysis → structured JSON
                 │     · weekly coaching insight
                 │     · grounded chat over the user's own logs
                 ├─► Firestore (meals, activities, users)  [local JSON fallback]
                 ├─► Strava OAuth (activity sync, last 30 days)
                 └─► Rule-based VitalScore engine (explainable, WHO-aligned)
                       └─► anonymized aggregation → community pulse
```

## Run locally

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=your_ai_studio_key
export DISABLE_FIRESTORE=1        # uses local JSON storage
uvicorn app.main:app --port 8080
# open http://localhost:8080
```

## Deploy to Cloud Run (one command)

```bash
gcloud run deploy vitallens \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY,STRAVA_CLIENT_ID=YOUR_ID,STRAVA_CLIENT_SECRET=YOUR_SECRET
```

Then set the public URL (needed for Strava OAuth redirects):

```bash
gcloud run services update vitallens --region asia-south1 \
  --update-env-vars PUBLIC_BASE_URL=https://YOUR-SERVICE-URL.run.app
```

## Sign-in

Sign-in is disabled for the hackathon demo. The browser creates a local demo user
id and sends it as `X-User-Id` on API calls.

If the service previously had Google or Supabase auth variables, remove them:

```bash
gcloud run services update vitallens --region asia-south1 \
  --remove-env-vars GOOGLE_CLIENT_ID,GOOGLE_OAUTH_CLIENT_ID,VITE_GOOGLE_CLIENT_ID,NEXT_PUBLIC_GOOGLE_CLIENT_ID,AUTH_PROVIDER,SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_JWT_SECRET,VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY,NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY
```

## Strava activity sync

Set these Cloud Run environment variables:

```bash
gcloud run services update vitallens --region asia-south1 \
  --update-env-vars STRAVA_CLIENT_ID=YOUR_ID,STRAVA_CLIENT_SECRET=YOUR_SECRET,PUBLIC_BASE_URL=https://YOUR-SERVICE-URL.run.app
```

In your Strava app settings (strava.com/settings/api), set **Authorization Callback Domain** to `YOUR-SERVICE-URL.run.app` (no https://, no path).

The first **Connect Strava** click runs OAuth and imports the last 30 days of activities. The app stores Strava refresh tokens on the user record, so future **Re-sync Strava** clicks refresh the access token and pull the latest activities through `POST /api/strava/sync`. Strava activity IDs are saved as `strava-<id>`, so repeated syncs update existing activities instead of duplicating them.

**Firestore:** create a database in *Native mode* in the same project (Console → Firestore → Create database). The Cloud Run default service account needs the *Cloud Datastore User* role (usually automatic). If Firestore is unreachable the app automatically falls back to local storage so the demo never breaks.

**Using Vertex AI instead of an AI Studio key:** set `GOOGLE_GENAI_USE_VERTEXAI=true` and `GOOGLE_CLOUD_PROJECT=your-project` (and remove `GEMINI_API_KEY`).

## Demo flow (for judges)

1. Dashboard → **Load demo week** → VitalScore ring animates, risk signals + breakdown appear.
2. Log Meal → upload a food photo, add portion note → **Analyze with Gemini** → itemized nutrition table → save.
3. Dashboard → **Generate AI weekly insight** → Gemini coaching narrative referencing real numbers.
4. Coach → ask "Can I eat biryani tonight?" — answer grounded in your own week.
5. Community → anonymized ward-level pulse for city health stakeholders.

## Responsible AI

- Score arithmetic is fully rule-based and auditable (WHO/ICMR-aligned targets shown in UI); Gemini writes narratives, never the score.
- Signals, not diagnoses — stated in the product.
- Community view uses anonymized aggregates only; individual logs never leave the score engine.
- Google Fit API is closed to new integrations (deprecated end-2026); roadmap targets Health Connect + Google Health API.

## Stack

Gemini 2.5 Flash · Vertex AI / AI Studio · Cloud Run · Firestore · FastAPI · Chart.js · Strava API
