# Stage 1: Build
# Docker context: repo root (.)
# Dockerfile path: backend/Dockerfile
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files from backend/ subdirectory (context is repo root)
COPY backend/package*.json ./

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm install

# Copy source code and build scripts from backend/ subdirectory
COPY backend/tsconfig.json ./
COPY backend/fix-esm-imports.mjs ./
COPY backend/src ./src

# Build the TypeScript code (tsc + ESM import fixer)
RUN npm run build

# Stage 2: Production
FROM node:22-alpine AS runner

# Set Node environment to production
ENV NODE_ENV=production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create a non-root user to run the app
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy package files and install ONLY production dependencies
COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled output from the builder stage
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Change ownership of the app directory to the non-root user
RUN mkdir -m 700 /app/uploads && chown -R nodejs:nodejs /app

# Switch to the non-root user
USER nodejs

# Expose the application port
EXPOSE 3001

# Use dumb-init as the entrypoint to handle PID 1 responsibilities
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Run the application
CMD ["node", "dist/index.js"]