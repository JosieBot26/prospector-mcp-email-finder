FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ ./src/
COPY README.md LICENSE ./

EXPOSE 3100

CMD ["node", "src/http-server.js"]
