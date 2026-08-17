# TermDeck Remote relay

This directory contains the hosted authentication and routing service for TermDeck Remote. It serves Google login,
matches one local connector to each Google account, proxies authenticated HTTP requests, and multiplexes browser
WebSockets over the computer's outbound connector.

## Google authentication

Create a Google OAuth client manually in Google Auth Platform:

1. Configure an external audience and the TermDeck Remote app branding.
2. Create a Web application client.
3. Add the deployed Cloud Run URL as an authorized JavaScript origin.
4. Set the client ID as `TERMDECK_REMOTE_GOOGLE_CLIENT_ID`.

Google requires OAuth clients to be created and accepted through Cloud Console. The relay uses Google Identity
Services callback mode and does not require a client secret.

## Cloud Run deployment

Create an Artifact Registry Docker repository, Firestore Native database, service account, and Secret Manager
secret. Build from the repository root so the shared protocol module is included:

```sh
gcloud builds submit . --config remote_service/cloudbuild.yaml --project "$PROJECT_ID"

gcloud run deploy termdeck-remote \
  --project "$PROJECT_ID" \
  --region us-central1 \
  --image "us-central1-docker.pkg.dev/$PROJECT_ID/termdeck-remote/relay:latest" \
  --service-account "termdeck-remote@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --max-instances 1 \
  --min-instances 0 \
  --concurrency 1000 \
  --timeout 3600 \
  --cpu 1 \
  --memory 512Mi \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,TERMDECK_REMOTE_PUBLIC_URL=$PUBLIC_URL,TERMDECK_REMOTE_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID" \
  --set-secrets "TERMDECK_REMOTE_SESSION_SECRET=termdeck-remote-session-secret:latest"
```

`--allow-unauthenticated` is required because Google login and the connector handshake occur inside the
application. Proxy routes still require a valid TermDeck Remote browser session, and connector routes require the
active signed connector credential.

Cloud Run limits WebSockets to 60 minutes and session affinity is only best effort. The local connector and browser
already reconnect, but this version intentionally caps the service at one instance so both sides share the same
in-memory connection registry.

Remote pages pause after `TERMDECK_REMOTE_BROWSER_IDLE_SECONDS`, which defaults to 600 seconds. The authenticated
idle page holds no local tunnel or polling connection and reloads the prior TermDeck route on the next interaction.
