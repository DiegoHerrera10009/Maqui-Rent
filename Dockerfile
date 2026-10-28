FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY services ./services
ENV NODE_ENV=production
CMD ["node", "services/web/server.js"]
