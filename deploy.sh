#!/bin/bash
# DevTrack Production Deployment Script
# Usage: ./deploy.sh [--no-build]
#
# Deploys the stack defined in docker-compose.prod.yml (api, frontend, workers,
# redis, mongo). Settings come from .env.production in the repo root.

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

echo -e "${GREEN}==> DevTrack Deployment${NC}"

# Parse args
SKIP_BUILD=false
if [[ "$1" == "--no-build" ]]; then
    SKIP_BUILD=true
fi

# Check for the production env file
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}WARNING: $ENV_FILE not found.${NC}"
    echo "Create $ENV_FILE in the repo root (see DEPLOYMENT.md for the variables) and run again."
    exit 1
fi
COMPOSE+=(--env-file "$ENV_FILE")

# Build containers
if [ "$SKIP_BUILD" = false ]; then
    echo -e "\n${GREEN}==> Building containers...${NC}"
    "${COMPOSE[@]}" build --parallel
fi

# Start services
echo -e "\n${GREEN}==> Starting services...${NC}"
"${COMPOSE[@]}" up -d

# Wait for the api service to answer its health endpoint
echo -e "\n${GREEN}==> Checking health...${NC}"
API_HEALTHY=false
for i in {1..30}; do
    if "${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" > /dev/null 2>&1; then
        API_HEALTHY=true
        break
    fi
    echo "Waiting for api... ($i/30)"
    sleep 2
done

if [ "$API_HEALTHY" = true ]; then
    echo -e "\n${GREEN}==> Deployment successful!${NC}"
    echo -e "\nServices:"
    "${COMPOSE[@]}" ps
else
    echo -e "\n${YELLOW}API health check failed. Check logs:${NC}"
    "${COMPOSE[@]}" logs api
    exit 1
fi
