#!/bin/bash
# FAFO Drive Proxy — One-command Cloud Run deployment
# Files expected in: ~/Downloads/FAFO/

PROJECT_ID="project-b0292460-be69-4b2e-b3c"

cd ~/Downloads/FAFO

gcloud config set project $PROJECT_ID

gcloud services enable run.googleapis.com drive.googleapis.com cloudbuild.googleapis.com \
  --project $PROJECT_ID

gcloud iam service-accounts create fafo-drive-proxy \
  --display-name="FAFO Drive Proxy" \
  --project $PROJECT_ID 2>/dev/null || echo "Service account already exists, continuing..."

echo ""
echo "============================================================"
echo "IMPORTANT: Share your '1 - FAFO App' Google Drive folder"
echo "with this service account email (Editor access):"
echo ""
echo "  fafo-drive-proxy@${PROJECT_ID}.iam.gserviceaccount.com"
echo ""
echo "Press Enter once you've done that to continue deployment..."
echo "============================================================"
read

gcloud run deploy fafo-drive-proxy \
  --source . \
  --region us-central1 \
  --service-account fafo-drive-proxy@${PROJECT_ID}.iam.gserviceaccount.com \
  --set-env-vars CASES_FOLDER_ID=1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ \
  --set-env-vars ALLOWED_ORIGIN=* \
  --allow-unauthenticated \
  --memory 256Mi \
  --min-instances 0 \
  --max-instances 2 \
  --project $PROJECT_ID

echo ""
echo "Deployment complete. Copy the Service URL above and send it to Claude."
