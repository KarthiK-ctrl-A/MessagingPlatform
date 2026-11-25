FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
# Workspace discovery accepts new apps/packages without editing this Dockerfile.
COPY apps/ apps/
COPY packages/ packages/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build
CMD ["node", "apps/api-gateway/dist/main.js"]
