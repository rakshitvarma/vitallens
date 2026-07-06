# VitalLens

VitalLens is a lifestyle intelligence web app built for the Gen AI Academy Hackathon. It helps users understand how food intake and movement patterns affect everyday health signals.

Live app: https://vitallens-s3cdt46tda-el.a.run.app/

## What It Does

- Meal photo analysis: upload a meal photo and Gemini estimates dishes, serving details, calories, protein, carbs, fat, sugar, fiber, sodium, and salt.
- Editable meal logs: review recent meals and correct nutrition or serving details manually.
- Movement tracking: log workouts manually or sync recent activities from Strava.
- VitalScore dashboard: see a week or month score with food, movement, risk signals, day logs, and comparisons.
- Personal targets: set daily food goals and weekly movement goals for calories, sugar, sodium, protein, fiber, steps, active minutes, and burn.
- Dark mode: switch between light and dark themes with readable dashboard, form, and table colors.
- PDF export: download the selected week/month report with summary and tabular food, movement, score, comparison, and day-log data.
- Coach chat: ask questions about your own logged data.
- Community pulse: view anonymized aggregate wellness signals for public-health style insights.

## Quick Demo Flow

1. Open the live app.
2. Click `Load demo week` on the Dashboard.
3. Review the VitalScore, risk signals, food intelligence, movement intelligence, and day log.
4. Open `Meals`, upload a food photo, analyze it, and save it to the log.
5. Open `Movement`, add an activity or connect Strava.
6. Use `Export PDF` to download the current report.
7. Try the Coach tab with a question like: `Can I eat biryani tonight?`

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
  --update-env-vars GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
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
STRAVA_CLIENT_ID=optional for Strava OAuth
STRAVA_CLIENT_SECRET=optional for Strava OAuth
PUBLIC_BASE_URL=required for Strava redirects in deployment
```

## Notes

- Sign-in is disabled for the hackathon demo. The app creates a local demo user in the browser.
- Gemini generates nutrition estimates and coaching text. The score is rule-based and transparent.
- VitalLens shows lifestyle signals, not medical diagnosis.
- Firestore is used in Cloud Run when available; local development can use JSON storage with `DISABLE_FIRESTORE=1`.

## Stack

FastAPI, Gemini, Google Cloud Run, Firestore, Chart.js, Strava API, HTML, CSS, JavaScript.
