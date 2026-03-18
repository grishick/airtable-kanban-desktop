#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="airtable-kanban-oauth"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DIR="$(dirname "$0")"

echo "Building zip..."
cd "$DIR"
npm install --prefix . --omit=dev
zip -r lambda.zip index.mjs node_modules

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://lambda.zip \
  --region "$REGION"

rm -f lambda.zip
echo "Done."
