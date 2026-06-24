FROM node:22-slim

WORKDIR /app

# 의존성 먼저 설치 (캐시 활용)
COPY package*.json ./
RUN npm install

# 소스 복사 후 빌드
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "dist/index.js"]
