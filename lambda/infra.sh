#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="airtable-kanban-oauth"
TABLE_NAME="airtable-kanban-oauth"
ROLE_NAME="airtable-kanban-oauth-role"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "=== Creating DynamoDB table ==="
aws dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=state,AttributeType=S \
  --key-schema AttributeName=state,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION"

aws dynamodb update-time-to-live \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region "$REGION"

echo "=== Creating IAM role ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST" \
  --query 'Role.Arn' --output text)

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

TABLE_ARN=$(aws dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --query 'Table.TableArn' --output text --region "$REGION")

INLINE_POLICY=$(cat <<EOF
{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],
    "Resource":"$TABLE_ARN"
  }]
}
EOF
)
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBAccess" \
  --policy-document "$INLINE_POLICY"

echo "Waiting for IAM role to propagate..."
sleep 15

echo "=== Creating Lambda function ==="
# Build initial zip
cd "$(dirname "$0")"
npm install --prefix . --omit=dev
zip -r lambda.zip index.mjs node_modules

aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs20.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb://lambda.zip \
  --timeout 30 \
  --memory-size 128 \
  --environment "Variables={AIRTABLE_CLIENT_ID=PLACEHOLDER,AIRTABLE_CLIENT_SECRET=PLACEHOLDER,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=PLACEHOLDER}" \
  --region "$REGION"

echo "=== Enabling Function URL ==="
FUNCTION_URL=$(aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type NONE \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type"]}' \
  --query 'FunctionUrl' --output text \
  --region "$REGION")

# Allow public invocations
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$REGION"

# Update LAMBDA_BASE_URL env var (strip trailing slash)
BASE_URL="${FUNCTION_URL%/}"
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --environment "Variables={AIRTABLE_CLIENT_ID=PLACEHOLDER,AIRTABLE_CLIENT_SECRET=PLACEHOLDER,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=$BASE_URL}" \
  --region "$REGION"

rm -f lambda.zip

echo ""
echo "=== Done ==="
echo ""
echo "Function URL: $FUNCTION_URL"
echo ""
echo "Next steps:"
echo "  1. Register your OAuth integration at https://airtable.com/create/oauth"
echo "     Redirect URI: ${BASE_URL}/callback"
echo "  2. Set real credentials:"
echo "     aws lambda update-function-configuration \\"
echo "       --function-name $FUNCTION_NAME \\"
echo "       --environment 'Variables={AIRTABLE_CLIENT_ID=<id>,AIRTABLE_CLIENT_SECRET=<secret>,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=$BASE_URL}'"
echo "  3. Copy the Function URL into App Settings → OAuth Lambda URL"
