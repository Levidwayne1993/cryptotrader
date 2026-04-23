FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm install typescript --save-dev && npx tsc && npm prune --production

CMD ["node", "dist/index.js"]
