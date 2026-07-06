#!/bin/bash
set -e

echo "========================================="
echo "  VitalLens — Setup & Deploy"
echo "========================================="
echo ""

# ---------- 1. Check prerequisites ----------
echo "Checking prerequisites..."

if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Install it:"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi
echo "✅ gcloud CLI found"

if ! command -v git &> /dev/null; then
    echo "❌ git not found. Install it first."
    exit 1
fi
echo "✅ git found"

# ---------- 2. Collect config ----------
echo ""
echo "--- Configuration ---"

read -p "Google Cloud Project ID: " GCP_PROJECT
read -p "Gemini API Key (from aistudio.google.com/apikey): " GEMINI_KEY
read -p "Strava Client ID (leave blank to skip): " STRAVA_ID
read -p "Strava Client Secret (leave blank to skip): " STRAVA_SECRET
read -p "GitHub repo URL (e.g. https://github.com/you/vitallens.git): " GITHUB_URL

if [ -z "$GEMINI_KEY" ]; then
    echo "Gemini API key is required for meal analysis, weekly insight, and chat."
    exit 1
fi

# ---------- 3. Set GCP project ----------
echo ""
echo "Setting GCP project to: $GCP_PROJECT"
gcloud config set project "$GCP_PROJECT"

# Enable required APIs
echo "Enabling required APIs (this takes ~30s)..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    firestore.googleapis.com \
    aiplatform.googleapis.com \
    2>/dev/null || true
echo "✅ APIs enabled"

# ---------- 4. Create Firestore (if not exists) ----------
echo ""
echo "Creating Firestore database (Native mode, asia-south1)..."
gcloud firestore databases create \
    --location=asia-south1 \
    --type=firestore-native \
    2>/dev/null || echo "(Firestore already exists or created — OK)"
echo "✅ Firestore ready"

# ---------- 5. Deploy to Cloud Run ----------
echo ""
echo "Deploying to Cloud Run (this takes 2-4 minutes)..."

ENV_VARS="GEMINI_API_KEY=${GEMINI_KEY}"
if [ -n "$STRAVA_ID" ]; then
    ENV_VARS="${ENV_VARS},STRAVA_CLIENT_ID=${STRAVA_ID},STRAVA_CLIENT_SECRET=${STRAVA_SECRET}"
fi

gcloud run deploy vitallens \
    --source . \
    --region asia-south1 \
    --allow-unauthenticated \
    --memory 512Mi \
    --timeout 120 \
    --update-env-vars "$ENV_VARS" \
    --remove-env-vars GOOGLE_CLIENT_ID,GOOGLE_OAUTH_CLIENT_ID,VITE_GOOGLE_CLIENT_ID,NEXT_PUBLIC_GOOGLE_CLIENT_ID,AUTH_PROVIDER,SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_JWT_SECRET,VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY,NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY

# Get the deployed URL
SERVICE_URL=$(gcloud run services describe vitallens --region asia-south1 --format='value(status.url)')
echo ""
echo "✅ Deployed at: $SERVICE_URL"

# Set PUBLIC_BASE_URL for Strava OAuth
echo "Setting PUBLIC_BASE_URL..."
gcloud run services update vitallens \
    --region asia-south1 \
    --update-env-vars "PUBLIC_BASE_URL=${SERVICE_URL}"

# ---------- 6. Push to GitHub ----------
echo ""
if [ -n "$GITHUB_URL" ]; then
    echo "Setting up Git repo..."
    git init 2>/dev/null || true
    git add -A
    git commit -m "VitalLens — AI Decision Intelligence for Everyday Health" 2>/dev/null || true
    git branch -M main
    git remote remove origin 2>/dev/null || true
    git remote add origin "$GITHUB_URL"
    git push -u origin main --force
    echo "✅ Pushed to GitHub"
else
    echo "⚠️  Skipped GitHub push (no URL provided)"
fi

# ---------- 7. Summary ----------
echo ""
echo "========================================="
echo "  🎉 VitalLens is LIVE!"
echo "========================================="
echo ""
echo "  App URL:    $SERVICE_URL"
echo "  GitHub:     $GITHUB_URL"
echo "  Region:     asia-south1"
echo "  Project:    $GCP_PROJECT"
echo ""
echo "--- For Strava (optional) ---"
echo "  Go to: https://www.strava.com/settings/api"
echo "  Set Authorization Callback Domain to:"
DOMAIN=$(echo "$SERVICE_URL" | sed 's|https://||')
echo "  $DOMAIN"
echo ""
echo "--- Quick test ---"
echo "  curl $SERVICE_URL/api/health"
echo ""
echo "--- Demo flow for judges ---"
echo "  1. Open $SERVICE_URL"
echo "  2. Click 'Load demo week' on Dashboard"
echo "  3. Upload a meal photo → Analyze with Gemini"
echo "  4. Click 'Generate AI weekly insight'"
echo "  5. Try Coach → 'Can I eat biryani tonight?'"
echo "  6. Check Community tab"
echo "========================================="
