# VitalLens

VitalLens turns everyday food, movement, and habit data into clear lifestyle signals for better everyday health.

Live app: https://vitallens-s3cdt46tda-el.a.run.app/

## What It Does

- Meal analysis: upload a meal photo with portion details, or type what you ate, and Gemini breaks it into dishes, servings, calories, protein, carbs, fat, sugar, fiber, sodium, and salt.
- Editable meal logs: review the analysis, save it, and correct any item, serving, total, or note later.
- Movement tracking: log workouts manually or connect Strava to pull recent activities.
- VitalScore dashboard: compare food intake, movement, risk signals, day logs, and week/month trends in one view.
- Personal targets: set daily food goals and weekly movement goals for calories, sugar, sodium, protein, fiber, steps, active minutes, and burn.
- Coach chat: ask questions grounded in your own meal and activity history.
- PDF reports: export a dashboard-style report with score summary, trend graph, intelligence markers, and detailed tables.
- Community pulse: view anonymized aggregate movement and lifestyle patterns for population-level insight.

## User Flow

1. Start on the Dashboard to see the current week or month, VitalScore, food intelligence, movement intelligence, risk signals, trend chart, and day log.
2. Go to Meals and choose either `Photo + details` or `Details only`.
3. Gemini returns an itemized meal breakdown. Review the table, then save it to recent meals.
4. Edit saved meals when the estimate needs correction.
5. Go to Movement to add manual activities such as walking, running, gym, cycling, yoga, or sport.
6. Optionally connect Strava to sync recent workouts automatically.
7. Set personal targets so the score and progress markers reflect the user's goals.
8. Export the selected period as a PDF report for sharing or review.
9. Use Coach to ask practical questions about the logged data.

## Architecture

```text
Browser SPA
  -> FastAPI backend on Cloud Run
      -> Gemini for meal analysis, weekly insight, and coach responses
      -> Rule-based VitalScore engine for transparent scoring
      -> Firestore for deployed persistence
      -> Local JSON storage when DISABLE_FIRESTORE=1
      -> Strava OAuth and activity sync
```

### Frontend

The app is a lightweight HTML/CSS/JavaScript single-page interface served from FastAPI. It handles tab navigation, meal upload/text entry, activity logging, dashboard rendering, dark mode, PDF export, and Chart.js visualizations.

### Backend

FastAPI exposes APIs for dashboard analytics, meal analysis, meal logs, movement logs, targets, Strava OAuth, coach chat, and community aggregates. It normalizes meal and activity records before saving so the dashboard can compute consistent summaries.

### Gemini

Gemini powers the generated parts of the experience: photo-based meal analysis, text-only meal parsing, weekly insights, and coach responses. The numeric score remains rule-based so the dashboard stays transparent.

### Storage

Cloud Run uses Firestore when configured. Local development can use JSON storage by setting `DISABLE_FIRESTORE=1`, which keeps setup simple for running from the repo.

## Run Locally From The Repo

Requirements: Python 3.11 or 3.12 is recommended.

```bash
git clone https://github.com/rakshitvarma/vitallens.git
cd vitallens
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=YOUR_GEMINI_API_KEY
export DISABLE_FIRESTORE=1
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Open:

```text
http://localhost:8080
```

PowerShell version:

```powershell
git clone https://github.com/rakshitvarma/vitallens.git
cd vitallens
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
$env:DISABLE_FIRESTORE="1"
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Deploy To Google Cloud Run

From Cloud Shell, inside the repo:

```bash
cd ~/vitallens
git pull
gcloud run deploy vitallens \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --update-env-vars GEMINI_API_KEY='YOUR_GEMINI_API_KEY',AUTH_PROVIDER=firebase,ADMIN_EMAILS='you@example.com',FIREBASE_API_KEY='YOUR_FIREBASE_API_KEY',FIREBASE_AUTH_DOMAIN='vitallens-501613.firebaseapp.com',FIREBASE_PROJECT_ID='vitallens-501613',FIREBASE_APP_ID='YOUR_FIREBASE_APP_ID',FIREBASE_STORAGE_BUCKET='vitallens-501613.appspot.com',FIREBASE_MESSAGING_SENDER_ID='YOUR_SENDER_ID'
```

If Strava sync is needed, include these variables too:

```bash
gcloud run services update vitallens \
  --region asia-south1 \
  --update-env-vars STRAVA_CLIENT_ID='YOUR_STRAVA_CLIENT_ID',STRAVA_CLIENT_SECRET='YOUR_STRAVA_CLIENT_SECRET',PUBLIC_BASE_URL='https://vitallens-s3cdt46tda-el.a.run.app'
```

In the Strava developer settings, set the Authorization Callback Domain to:

```text
vitallens-s3cdt46tda-el.a.run.app
```

## Environment Variables

```text
GEMINI_API_KEY=required for meal analysis, insights, and coach chat
DISABLE_FIRESTORE=1 for local JSON storage
AUTH_PROVIDER=firebase for Firebase Authentication; use AUTH_PROVIDER=demo only for local demo mode
ADMIN_EMAILS=comma-separated admin emails that can view user metrics
FIREBASE_API_KEY=Firebase web app API key
FIREBASE_AUTH_DOMAIN=Firebase auth domain
FIREBASE_PROJECT_ID=Firebase project id
FIREBASE_APP_ID=Firebase web app id
FIREBASE_STORAGE_BUCKET=Firebase storage bucket
FIREBASE_MESSAGING_SENDER_ID=Firebase sender id
STRAVA_CLIENT_ID=optional for Strava OAuth
STRAVA_CLIENT_SECRET=optional for Strava OAuth
PUBLIC_BASE_URL=required for Strava redirects in deployment
```

## Notes

- Sign-in uses Firebase Authentication / Google Cloud Identity Platform with Google and email/password providers.
- Enable Google and Email/Password providers in Firebase Authentication, and add the Cloud Run domain plus localhost to authorized domains.
- Gemini generates nutrition estimates and coaching text. VitalScore is computed by a rule-based scoring engine.
- Firestore is used in Cloud Run when available; local development can use JSON storage with `DISABLE_FIRESTORE=1`.

## Stack

FastAPI, Gemini, Google Cloud Run, Firestore, Chart.js, Strava API, HTML, CSS, JavaScript.
