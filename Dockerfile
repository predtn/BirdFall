# BirdFall multiplayer server - image nhẹ cho Node.js + Socket.IO
FROM node:20-alpine

WORKDIR /app

# Cài dependencies trước để tận dụng cache layer của Docker (chỉ rebuild khi package.json đổi)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn còn lại (server.js, index.html, style.css, js/, questions.json...)
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
