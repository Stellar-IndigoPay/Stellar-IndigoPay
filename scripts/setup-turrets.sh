#!/bin/bash
# scripts/setup-turrets.sh
# Setup script for Stellar Turrets donation matching service

set -e

BACKEND_ENV="backend/.env"
API_URL="http://localhost:4000/api"

# Load environment to get API credentials if available
if [ -f "$BACKEND_ENV" ]; then
  export $(grep -v '^#' "$BACKEND_ENV" | xargs)
fi

COMMAND=$1
shift || true

if [ -z "$COMMAND" ] || [ "$COMMAND" = "help" ]; then
  echo "Usage: $0 [issue|rotate|revoke] [args]"
  echo "  issue [name] [scope] - Issue a new turret credential"
  echo "  rotate <turret_id>   - Rotate an existing turret credential"
  echo "  revoke <turret_id>   - Revoke a turret credential"
  exit 1
fi

if [ -z "$ADMIN_API_KEY" ]; then
  # Assuming local setup, you might need an access token, but since we have basic auth
  # fallback in local dev, this might be tricky. Let's warn the user.
  echo "⚠️  ADMIN_API_KEY not found in $BACKEND_ENV"
  echo "   You need an admin bearer token to manage turrets."
  exit 1
fi

if [ "$COMMAND" = "issue" ]; then
  echo "🚀 Issuing new Turret credential..."
  NAME=${1:-"Local Turret"}
  SCOPE=${2:-"matching"}
  
  RESPONSE=$(curl -s -X POST "$API_URL/admin/turrets" \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NAME\", \"scope\": \"$SCOPE\"}")
    
  if echo "$RESPONSE" | grep -q '"success":true'; then
    TURRET_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*' | grep -o '[^"]*$')
    TURRET_API_KEY=$(echo "$RESPONSE" | grep -o '"apiKey":"[^"]*' | grep -o '[^"]*$')
    
    echo "✅ Turret issued successfully!"
    echo "Turret ID: $TURRET_ID"
    
    if ! grep -q "TURRET_API_KEY" "$BACKEND_ENV"; then
      echo "TURRET_API_KEY=$TURRET_API_KEY" >> "$BACKEND_ENV"
    else
      sed -i.bak "s/^TURRET_API_KEY=.*/TURRET_API_KEY=$TURRET_API_KEY/" "$BACKEND_ENV" && rm -f "$BACKEND_ENV.bak"
    fi
    if ! grep -q "ENABLE_TURRETS=true" "$BACKEND_ENV"; then
      echo "ENABLE_TURRETS=true" >> "$BACKEND_ENV"
      echo "TURRETS_PORT=3001" >> "$BACKEND_ENV"
    fi
    echo "✅ Updated $BACKEND_ENV"
  else
    echo "❌ Failed to issue turret: $RESPONSE"
  fi

elif [ "$COMMAND" = "rotate" ]; then
  TURRET_ID=$1
  if [ -z "$TURRET_ID" ]; then
    echo "Usage: $0 rotate <turret_id>"
    exit 1
  fi
  
  echo "🔄 Rotating Turret credential for $TURRET_ID..."
  RESPONSE=$(curl -s -X POST "$API_URL/admin/turrets/$TURRET_ID/rotate" \
    -H "Authorization: Bearer $ADMIN_API_KEY")
    
  if echo "$RESPONSE" | grep -q '"success":true'; then
    TURRET_API_KEY=$(echo "$RESPONSE" | grep -o '"apiKey":"[^"]*' | grep -o '[^"]*$')
    echo "✅ Turret rotated successfully! Dual-key window is active for 24h."
    
    if grep -q "TURRET_API_KEY" "$BACKEND_ENV"; then
      sed -i.bak "s/^TURRET_API_KEY=.*/TURRET_API_KEY=$TURRET_API_KEY/" "$BACKEND_ENV" && rm -f "$BACKEND_ENV.bak"
      echo "✅ Updated $BACKEND_ENV with new key"
    else
      echo "TURRET_API_KEY=$TURRET_API_KEY" >> "$BACKEND_ENV"
    fi
  else
    echo "❌ Failed to rotate turret: $RESPONSE"
  fi

elif [ "$COMMAND" = "revoke" ]; then
  TURRET_ID=$1
  if [ -z "$TURRET_ID" ]; then
    echo "Usage: $0 revoke <turret_id>"
    exit 1
  fi
  
  echo "🚫 Revoking Turret credential for $TURRET_ID..."
  RESPONSE=$(curl -s -X POST "$API_URL/admin/turrets/$TURRET_ID/revoke" \
    -H "Authorization: Bearer $ADMIN_API_KEY")
    
  if echo "$RESPONSE" | grep -q '"success":true'; then
    echo "✅ Turret revoked successfully!"
  else
    echo "❌ Failed to revoke turret: $RESPONSE"
  fi
else
  echo "Unknown command: $COMMAND"
  exit 1
fi
