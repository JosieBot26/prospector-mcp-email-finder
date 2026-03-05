# Multi-stage build for minimal image size
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install only production dependencies
RUN npm install --omit=dev --ignore-scripts

# Run as non-root user
USER node

# Railway sets PORT dynamically — don't hardcode it
EXPOSE 8080

CMD ["node", "dist/index.js"]
