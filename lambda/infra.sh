#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="airtable-kanban-oauth"
TABLE_NAME="airtable-kanban-oauth"
ROLE_NAME="airtable-kanban-oauth-role"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

usage() {
  cat <<'EOF'
Usage: infra.sh [--profile <name>] [--region <aws-region>]

Options:
  -p, --profile   AWS CLI profile name (also reads AWS_PROFILE env var)
  -r, --region    AWS region (defaults to AWS_DEFAULT_REGION or us-east-1)
  -h, --help      Show this help
EOF
}

AWS_PROFILE_NAME="${AWS_PROFILE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--profile)
      AWS_PROFILE_NAME="${2:-}"
      shift 2
      ;;
    -r|--region)
      REGION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

AWS=(aws)
if [[ -n "${AWS_PROFILE_NAME}" ]]; then
  AWS+=(--profile "${AWS_PROFILE_NAME}")
fi

echo "=== Creating DynamoDB table ==="
if "${AWS[@]}" dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" &>/dev/null; then
  echo "Table already exists, skipping create."
else
  "${AWS[@]}" dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=state,AttributeType=S \
    --key-schema AttributeName=state,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION"
fi

"${AWS[@]}" dynamodb wait table-exists \
  --table-name "$TABLE_NAME" \
  --region "$REGION"

"${AWS[@]}" dynamodb update-time-to-live \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region "$REGION" || true

echo "=== Creating IAM role ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if "${AWS[@]}" iam get-role --role-name "$ROLE_NAME" &>/dev/null; then
  echo "IAM role already exists, skipping create."
  ROLE_ARN=$("${AWS[@]}" iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
else
  ROLE_ARN=$("${AWS[@]}" iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" \
    --query 'Role.Arn' --output text)
fi

"${AWS[@]}" iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true

TABLE_ARN=$("${AWS[@]}" dynamodb describe-table \
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
"${AWS[@]}" iam put-role-policy \
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

if "${AWS[@]}" lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &>/dev/null; then
  echo "Lambda already exists, updating code only."
  "${AWS[@]}" lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://lambda.zip \
    --region "$REGION"
else
  "${AWS[@]}" lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://lambda.zip \
    --timeout 30 \
    --memory-size 128 \
    --environment "Variables={AIRTABLE_CLIENT_ID=PLACEHOLDER,AIRTABLE_CLIENT_SECRET=PLACEHOLDER,DYNAMODB_TABLE=$TABLE_NAME,LAMBDA_BASE_URL=PLACEHOLDER}" \
    --region "$REGION"
fi

echo "=== Enabling Function URL ==="
if "${AWS[@]}" lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" &>/dev/null; then
  echo "Function URL already exists, skipping create."
  FUNCTION_URL=$("${AWS[@]}" lambda get-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --query 'FunctionUrl' --output text \
    --region "$REGION")
else
  FUNCTION_URL=$("${AWS[@]}" lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE \
    --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type"]}' \
    --query 'FunctionUrl' --output text \
    --region "$REGION")
fi

# Allow public invocations — requires BOTH InvokeFunctionUrl and InvokeFunction for auth-type NONE
# (idempotent: remove existing statements first)
"${AWS[@]}" lambda remove-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --region "$REGION" 2>/dev/null || true
"${AWS[@]}" lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$REGION"

"${AWS[@]}" lambda remove-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicInvoke \
  --region "$REGION" 2>/dev/null || true
"${AWS[@]}" lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicInvoke \
  --action lambda:InvokeFunction \
  --principal "*" \
  --region "$REGION"

# Update LAMBDA_BASE_URL env var (strip trailing slash)
BASE_URL="${FUNCTION_URL%/}"
"${AWS[@]}" lambda update-function-configuration \
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
echo "  3. Copy the OAuth endpoint base URL into App Settings → OAuth Lambda URL"
echo "     - Lambda Function URL base: ${BASE_URL}"
echo "     - Or API Gateway custom domain base: https://your-domain.com"
